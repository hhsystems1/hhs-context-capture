import type { CapabilitySupport } from "@hhs/discovery-schema";
import type {
  DiscoveryAdapter,
  DiscoveryPortContext,
  DiscoveryTraversalPort,
  RawContainerObservation,
  RawItemObservation,
  SourceIdentification,
  TraversalSnapshot
} from "@hhs/discovery-engine/adapter-contract";
import { ChatGptDomSidebarPort, type SidebarInventoryPort } from "./inventory-adapter.js";

export const CHATGPT_DISCOVERY_ADAPTER_VERSION = "0.1.0";

/** The container every conversation belongs to when no project segment is visible in its URL. */
export const ACCOUNT_ROOT_CONTAINER = "account_root";

/**
 * What this adapter can and cannot observe from the rendered ChatGPT sidebar.
 *
 * `projects` is `unknown` rather than `supported` on purpose: a project is only visible when a
 * conversation URL carries a project segment, so a project containing no listed conversation is
 * invisible here. Declaring it `supported` would let an empty result be misread as "no projects".
 */
export const CHATGPT_DISCOVERY_CAPABILITIES: Record<string, CapabilitySupport> = {
  conversations: "supported",
  conversation_ids: "supported",
  conversation_titles: "supported",
  conversation_timestamps: "unknown",
  projects: "unknown",
  message_counts: "unsupported",
  branches: "unsupported",
  conversation_completeness: "unsupported",
  versions: "unsupported",
  attachments: "unsupported",
  archived_conversations: "unknown"
};

/**
 * Adapts the existing, already-verified read-only sidebar port to the universal traversal contract.
 * No new DOM traversal is introduced: the selectors, scrolling, and sanitization remain the ones the
 * capture and inventory paths already use.
 */
export class ChatGptSidebarTraversalPort implements DiscoveryTraversalPort {
  constructor(private readonly sidebar: SidebarInventoryPort) {}

  inspect(): TraversalSnapshot {
    const snapshot = this.sidebar.inspect();
    const containers = new Map<string, RawContainerObservation>();
    const items: RawItemObservation[] = [];

    containers.set(ACCOUNT_ROOT_CONTAINER, {
      source_native_id: ACCOUNT_ROOT_CONTAINER,
      container_kind: "account_root",
      title: "All listed conversations",
      depth: 0,
      evidence_locator: "chatgpt:sidebar:account_root",
      sanitized_evidence: "<div data-container=\"account_root\">All listed conversations</div>",
      order_hint: -1,
      source_metadata: { enumeration_basis: "sidebar_listing" }
    });

    for (const row of snapshot.rows) {
      const identity = row.conversation_id;
      if (!identity) continue;
      const project = projectReference(row.source_url);
      const containerRef = project?.id ?? ACCOUNT_ROOT_CONTAINER;

      if (project && !containers.has(project.id)) {
        containers.set(project.id, {
          source_native_id: project.id,
          container_kind: "project_inferred",
          title: project.title,
          source_url: project.url,
          depth: 1,
          evidence_locator: `chatgpt:sidebar:project:${project.id}`,
          sanitized_evidence: `<div data-container="${project.id}">${project.title}</div>`,
          order_hint: -0.5,
          source_metadata: { enumeration_basis: "inferred_from_conversation_url" }
        });
      }

      items.push({
        source_native_id: identity,
        container_ref: containerRef,
        item_kind: "conversation",
        title: row.title,
        ...(row.source_url === undefined ? {} : { source_url: row.source_url }),
        declared: row.accessible_timestamp === undefined ? {} : { modified_at: row.accessible_timestamp },
        evidence_class: "original_evidence",
        capture_feasibility: "capturable",
        evidence_locator: row.evidence_locator,
        sanitized_evidence: row.sanitized_html,
        order_hint: row.order_hint,
        source_metadata: { ...row.platform_metadata, ...(project ? { project_reference: project.id } : {}) }
      });
    }

    return {
      containers: [...containers.values()],
      items,
      position: snapshot.scroll_top,
      extent: snapshot.scroll_height,
      viewport: snapshot.client_height
    };
  }

  seek(position: number): void {
    this.sidebar.scrollTo(position);
  }

  waitForSettled(): Promise<void> {
    return this.sidebar.waitForSettled();
  }
}

export type SidebarPortFactory = (context: DiscoveryPortContext) => SidebarInventoryPort;

export class ChatGptDiscoveryAdapter implements DiscoveryAdapter {
  readonly sourceKind = "chatgpt";
  readonly adapterId = "chatgpt-sidebar-discovery";
  readonly adapterVersion = CHATGPT_DISCOVERY_ADAPTER_VERSION;
  readonly transport = "browser_dom" as const;
  readonly capabilities = CHATGPT_DISCOVERY_CAPABILITIES;

  /** The factory is injectable so the adapter can be exercised without a browser. */
  constructor(private readonly createSidebarPort: SidebarPortFactory = domSidebarPortFactory) {}

  identify(context: DiscoveryPortContext): SourceIdentification {
    const detected = /(^|\.)chatgpt\.com$/.test(context.host) || /(^|\.)chat\.openai\.com$/.test(context.host);
    return {
      detected,
      source_kind: this.sourceKind,
      confidence: detected ? "high" : "low",
      reasons: [`observed_host:${context.host}`]
    };
  }

  async openPort(context: DiscoveryPortContext): Promise<DiscoveryTraversalPort> {
    return new ChatGptSidebarTraversalPort(this.createSidebarPort(context));
  }
}

function domSidebarPortFactory(context: DiscoveryPortContext): SidebarInventoryPort {
  const root = context.root;
  if (!isDocumentLike(root)) throw new Error("ChatGPT discovery requires the page document as its source root.");
  return new ChatGptDomSidebarPort(root);
}

function isDocumentLike(value: unknown): value is Document {
  return typeof value === "object" && value !== null && typeof (value as { querySelectorAll?: unknown }).querySelectorAll === "function";
}

interface ProjectReference {
  id: string;
  title: string;
  url: string;
}

/**
 * ChatGPT project conversations are served from `/g/g-p-<hash>-<slug>/c/<conversation>`.
 * The project reference is read from the URL only; nothing is inferred beyond what the link shows.
 */
export function projectReference(sourceUrl: string | undefined): ProjectReference | undefined {
  if (sourceUrl === undefined) return undefined;
  let pathname: string;
  let origin: string;
  try {
    const url = new URL(sourceUrl, "https://chatgpt.com");
    pathname = url.pathname;
    origin = url.origin;
  } catch {
    return undefined;
  }
  const match = /^\/g\/(g-p-[^/]+)\/c\//.exec(pathname);
  const id = match?.[1];
  if (id === undefined) return undefined;
  const slug = /^g-p-[0-9a-f]+-(.+)$/.exec(id)?.[1];
  return { id, title: slug ?? id, url: `${origin}/g/${id}` };
}
