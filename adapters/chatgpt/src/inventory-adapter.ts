import type { ConversationObservation, InventoryEvidence, InventoryRun } from "@hhs/inventory-schema";

const STABLE_BOUNDARY_PASSES = 4;
const MAX_SCROLL_PASSES = 2_000;

export interface SidebarRowSnapshot {
  conversation_id?: string;
  platform_conversation_id?: string;
  title: string;
  source_url?: string;
  accessible_timestamp?: string;
  sanitized_html: string;
  evidence_locator: string;
  order_hint: number;
  platform_metadata: Record<string, unknown>;
}

export interface SidebarSnapshot {
  rows: SidebarRowSnapshot[];
  scroll_top: number;
  scroll_height: number;
  client_height: number;
}

export interface SidebarInventoryPort {
  inspect(): SidebarSnapshot;
  scrollTo(top: number): void;
  waitForSettled(): Promise<void>;
}

export interface InventoryProgress {
  pass: number;
  unique_conversations: number;
  scroll_top: number;
  scroll_height: number;
}

export interface InventoryOptions {
  max_scroll_passes?: number;
  stable_boundary_passes?: number;
}

export class ChatGptSidebarInventoryAdapter {
  readonly platform = "chatgpt";
  readonly adapterVersion = "0.1.0";

  async inventory(port: SidebarInventoryPort, opaqueAccountReference: string, onProgress: (progress: InventoryProgress) => void = () => undefined, options: InventoryOptions = {}): Promise<InventoryRun> {
    const startedAt = new Date().toISOString();
    const inventoryId = crypto.randomUUID();
    const initial = port.inspect();
    const initialPosition = initial.scroll_top;
    const accumulated = new Map<string, AccumulatedRow>();
    const evidence: InventoryEvidence[] = [];
    const warnings: string[] = [];
    let collisionCount = 0;
    let earliestReached = false;
    let scrollStabilized = false;
    let countStabilized = false;

    observe(initial, accumulated, evidence);
    port.scrollTo(0);
    await port.waitForSettled();
    let snapshot = port.inspect();
    observe(snapshot, accumulated, evidence);
    const latestReached = snapshot.scroll_top <= 2;
    if (!latestReached) warnings.push("latest_sidebar_boundary_not_reached");

    let stableBottomPasses = 0;
    let stableCountPasses = 0;
    let previousCount = accumulated.size;
    let previousTop = -1;
    const maximumPasses = options.max_scroll_passes ?? MAX_SCROLL_PASSES;
    const stablePassesRequired = options.stable_boundary_passes ?? STABLE_BOUNDARY_PASSES;
    for (let pass = 0; pass < maximumPasses; pass += 1) {
      snapshot = port.inspect();
      collisionCount += observe(snapshot, accumulated, evidence);
      onProgress({ pass, unique_conversations: accumulated.size, scroll_top: snapshot.scroll_top, scroll_height: snapshot.scroll_height });
      stableCountPasses = accumulated.size === previousCount ? stableCountPasses + 1 : 0;
      previousCount = accumulated.size;
      const atBottom = snapshot.scroll_top + snapshot.client_height >= snapshot.scroll_height - 2;
      stableBottomPasses = atBottom && Math.abs(snapshot.scroll_top - previousTop) <= 2 ? stableBottomPasses + 1 : 0;
      if (stableBottomPasses >= stablePassesRequired && stableCountPasses >= stablePassesRequired) {
        earliestReached = true;
        scrollStabilized = true;
        countStabilized = true;
        break;
      }
      previousTop = snapshot.scroll_top;
      const step = Math.max(200, Math.floor(snapshot.client_height * 0.75));
      port.scrollTo(Math.min(snapshot.scroll_height, snapshot.scroll_top + step));
      await port.waitForSettled();
    }
    if (!earliestReached) warnings.push("earliest_sidebar_boundary_not_verified");
    if (!scrollStabilized) warnings.push("sidebar_scrolling_did_not_stabilize");
    if (!countStabilized) warnings.push("sidebar_observation_count_did_not_stabilize");
    if (collisionCount > 0) warnings.push(`conversation_identity_collisions:${collisionCount}`);

    port.scrollTo(initialPosition);
    await port.waitForSettled();
    const restored = Math.abs(port.inspect().scroll_top - initialPosition) <= 2;
    if (!restored) warnings.push("initial_sidebar_position_not_restored");

    const observations = await finalizeObservations(accumulated);
    if (observations.length === 0) warnings.push("no_conversation_rows_observed");
    const status = warnings.length === 0 ? "complete" as const : "needs_review" as const;
    const withoutHash = {
      schema_version: "0.1.0" as const,
      inventory_id: inventoryId,
      platform: { platform_id: "chatgpt", observed_host: locationHost() },
      account: { opaque_account_reference: opaqueAccountReference },
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      status,
      boundary_verification: {
        earliest_reached: earliestReached,
        latest_reached: latestReached,
        scroll_stabilized: scrollStabilized,
        observation_count_stabilized: countStabilized,
        initial_position_restored: restored
      },
      observations,
      evidence,
      warnings
    };
    return { ...withoutHash, snapshot_sha256: await browserSha256(stableJson(withoutHash)) };
  }
}

export class ChatGptDomSidebarPort implements SidebarInventoryPort {
  private readonly container: HTMLElement;

  constructor(private readonly document: Document) {
    const anchors = conversationAnchors(document);
    if (anchors.length === 0) throw new Error("No accessible ChatGPT conversation links were found in the sidebar. Expand the sidebar before inventory.");
    this.container = findScrollContainer(anchors[0]!) ?? fail("Could not identify the ChatGPT sidebar scroll container.");
  }

  inspect(): SidebarSnapshot {
    const containerRect = this.container.getBoundingClientRect();
    const rows = conversationAnchors(this.document).map((anchor, index): SidebarRowSnapshot => {
      const href = anchor.href;
      const identity = conversationIdentity(href);
      const row = anchor.closest<HTMLElement>("li, [role='listitem'], [data-testid*='conversation'], div") ?? anchor;
      const title = (anchor.getAttribute("aria-label") || anchor.getAttribute("title") || anchor.textContent || "").trim();
      const timestampElement = row.querySelector<HTMLElement>("time[datetime], time, [data-timestamp]");
      const accessibleTimestamp = timestampElement?.getAttribute("datetime") ?? timestampElement?.getAttribute("data-timestamp") ?? (timestampElement?.textContent?.trim() || undefined);
      return {
        ...(identity ? { conversation_id: identity, platform_conversation_id: identity } : {}),
        title,
        source_url: href,
        ...(accessibleTimestamp ? { accessible_timestamp: accessibleTimestamp } : {}),
        sanitized_html: sanitizeInventoryRow(row),
        evidence_locator: `chatgpt:sidebar:href:${new URL(href).pathname}`,
        order_hint: this.container.scrollTop + Math.max(0, row.getBoundingClientRect().top - containerRect.top) + index / 1_000,
        platform_metadata: { href_path: new URL(href).pathname }
      };
    });
    return { rows, scroll_top: this.container.scrollTop, scroll_height: this.container.scrollHeight, client_height: this.container.clientHeight };
  }

  scrollTo(top: number): void {
    this.container.scrollTop = top;
    this.container.dispatchEvent(new Event("scroll", { bubbles: true }));
  }

  async waitForSettled(): Promise<void> {
    await waitForQuiet(this.container, 250, 2_500);
  }
}

interface AccumulatedRow {
  identity: string;
  platformConversationId?: string;
  title: string;
  sourceUrl?: string;
  timestamp?: string;
  orderHint: number;
  evidenceIds: string[];
  evidenceLocators: string[];
  reviewReasons: string[];
  platformMetadata: Record<string, unknown>;
}

function observe(snapshot: SidebarSnapshot, target: Map<string, AccumulatedRow>, evidence: InventoryEvidence[]): number {
  let collisions = 0;
  for (const row of snapshot.rows) {
    const identity = row.conversation_id;
    if (!identity) continue;
    const evidenceId = crypto.randomUUID();
    evidence.push({
      evidence_id: evidenceId,
      kind: "sanitized_dom",
      media_type: "text/html",
      value: row.sanitized_html,
      sha256: "",
      evidence_locator: row.evidence_locator,
      captured_at: new Date().toISOString()
    });
    const existing = target.get(identity);
    const conflict = existing && (existing.title !== row.title || existing.sourceUrl !== row.source_url);
    if (conflict) collisions += 1;
    if (existing) {
      existing.orderHint = Math.min(existing.orderHint, row.order_hint);
      existing.evidenceIds.push(evidenceId);
      existing.evidenceLocators.push(row.evidence_locator);
      if (conflict && !existing.reviewReasons.includes("conflicting_observations_for_stable_identity")) existing.reviewReasons.push("conflicting_observations_for_stable_identity");
      if (!existing.timestamp && row.accessible_timestamp) existing.timestamp = row.accessible_timestamp;
    } else {
      target.set(identity, {
        identity,
        ...(row.platform_conversation_id ? { platformConversationId: row.platform_conversation_id } : {}),
        title: row.title,
        ...(row.source_url ? { sourceUrl: row.source_url } : {}),
        ...(row.accessible_timestamp ? { timestamp: row.accessible_timestamp } : {}),
        orderHint: row.order_hint,
        evidenceIds: [evidenceId],
        evidenceLocators: [row.evidence_locator],
        reviewReasons: [],
        platformMetadata: row.platform_metadata
      });
    }
  }
  return collisions;
}

async function finalizeObservations(accumulated: Map<string, AccumulatedRow>): Promise<ConversationObservation[]> {
  const rows = [...accumulated.values()].sort((a, b) => a.orderHint - b.orderHint || a.identity.localeCompare(b.identity));
  return Promise.all(rows.map(async (row, index) => {
    const fingerprintPayload = {
      conversation_id: row.identity,
      platform_conversation_id: row.platformConversationId ?? null,
      title: row.title,
      source_url: row.sourceUrl ?? null,
      visible_status_indicators: [],
      platform_metadata: { ...row.platformMetadata, accessible_timestamp: row.timestamp ?? null }
    };
    return {
      observation_id: crypto.randomUUID(),
      conversation_id: row.identity,
      ...(row.platformConversationId ? { platform_conversation_id: row.platformConversationId } : {}),
      title: row.title,
      ...(row.sourceUrl ? { source_url: row.sourceUrl } : {}),
      sidebar_position: index,
      observed_at: new Date().toISOString(),
      observation_fingerprint: await browserSha256(stableJson(fingerprintPayload)),
      visible_status_indicators: [],
      evidence_ids: row.evidenceIds,
      review_status: row.reviewReasons.length > 0 ? "needs_review" as const : "clear" as const,
      review_reasons: row.reviewReasons,
      platform_metadata: { ...row.platformMetadata, accessible_timestamp: row.timestamp ?? null, evidence_locators: row.evidenceLocators }
    };
  }));
}

export async function hashInventoryEvidence(run: InventoryRun): Promise<InventoryRun> {
  for (const evidence of run.evidence) evidence.sha256 = await browserSha256(evidence.value);
  const { snapshot_sha256: _snapshot, ...payload } = run;
  void _snapshot;
  run.snapshot_sha256 = await browserSha256(stableJson(payload));
  return run;
}

function conversationAnchors(document: Document): HTMLAnchorElement[] {
  return [...document.querySelectorAll<HTMLAnchorElement>("nav a[href], aside a[href]")].filter((anchor) => Boolean(conversationIdentity(anchor.href)) && isVisible(anchor));
}

function conversationIdentity(href: string): string | undefined {
  try {
    const parts = new URL(href).pathname.split("/").filter(Boolean);
    const index = parts.lastIndexOf("c");
    return index >= 0 && parts[index + 1] ? parts[index + 1] : undefined;
  } catch { return undefined; }
}

function findScrollContainer(anchor: HTMLElement): HTMLElement | undefined {
  let current: HTMLElement | null = anchor.parentElement;
  while (current) {
    const style = getComputedStyle(current);
    if (current.scrollHeight > current.clientHeight && /(auto|scroll)/.test(style.overflowY)) return current;
    current = current.parentElement;
  }
  return anchor.closest<HTMLElement>("nav, aside") ?? undefined;
}

function sanitizeInventoryRow(row: HTMLElement): string {
  const clone = row.cloneNode(true) as HTMLElement;
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
    for (const attribute of [...element.attributes]) {
      if (!["href", "aria-label", "title", "datetime", "data-timestamp", "role"].includes(attribute.name)) element.removeAttribute(attribute.name);
      if (attribute.name === "href") {
        try { element.setAttribute("href", new URL(attribute.value, location.href).pathname); } catch { element.removeAttribute("href"); }
      }
    }
  }
  for (const unsafe of clone.querySelectorAll("script, style, iframe, object, embed")) unsafe.remove();
  return clone.outerHTML;
}

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

async function waitForQuiet(target: HTMLElement, quietMs: number, maximumMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let timer = setTimeout(finish, quietMs);
    const maximum = setTimeout(finish, maximumMs);
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, quietMs); });
    observer.observe(target, { childList: true, subtree: true, attributes: true });
    function finish() { clearTimeout(timer); clearTimeout(maximum); observer.disconnect(); resolve(); }
  });
}

async function browserSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
  return value;
}

function locationHost(): string {
  return typeof location === "undefined" ? "chatgpt.com" : location.hostname;
}

function fail(message: string): never { throw new Error(message); }
