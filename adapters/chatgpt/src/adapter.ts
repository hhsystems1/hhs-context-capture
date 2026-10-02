import type {
  AttachmentReference,
  BranchRecord,
  CanonicalMessage,
  ContentBlock,
  EvidenceRecord,
  MessageRole,
  PreservedRepresentation,
  VerificationCheck,
} from "@hhs/canonical-schema";
import {
  MessageAccumulator,
  type AdapterContext,
  type ConversationIdentity,
  type ExtractedConversation,
  type MessageObservation,
  type PlatformAdapter,
} from "@hhs/capture-engine";

const MESSAGE_SELECTORS = ["[data-message-author-role]", "article[data-testid^='conversation-turn-']"];
const STABLE_PASSES = 3;
const MIN_SCROLL_PASSES = 200;
const EMERGENCY_MAX_SCROLL_PASSES = 5_000;
type ObservedBranchIndicator = { key: string; current?: number; total?: number; message_id?: string; observed_at: string };

export class ChatGptAdapter implements PlatformAdapter {
  readonly platform = "chatgpt";
  readonly adapterVersion = "0.1.2";

  async detect(context: AdapterContext) {
    const supportedHost = /(^|\.)(chatgpt\.com|chat\.openai\.com)$/.test(location.hostname);
    const hasConversation = findMessageElements(context.document).length > 0;
    return { detected: supportedHost && hasConversation, platform: this.platform, confidence: supportedHost && hasConversation ? "high" as const : "low" as const, reasons: [supportedHost ? "Supported ChatGPT host." : "Unsupported host.", hasConversation ? "Conversation turns found." : "No conversation turns found."] };
  }

  async identifyConversation(context: AdapterContext): Promise<ConversationIdentity> {
    const url = new URL(context.sourceUrl);
    const match = url.pathname.match(/\/c\/([^/?#]+)/);
    const title = context.document.title.replace(/\s*[-–|]\s*ChatGPT\s*$/i, "");
    return {
      conversationId: match?.[1] ?? `local-${await sha256(`${url.origin}${url.pathname}|${title}`)}`,
      ...(match?.[1] ? { platformConversationId: match[1] } : {}),
      title,
      sourceUrl: `${url.origin}${url.pathname}`,
    };
  }

  async capture(context: AdapterContext): Promise<ExtractedConversation> {
    const accumulator = new MessageAccumulator();
    const evidence: EvidenceRecord[] = [];
    const warnings: string[] = [];
    const observedBranchIndicators = new Map<string, ObservedBranchIndicator>();
    context.onProgress("Capturing initial viewport evidence");
    await addScreenshot(context, evidence, "initial_viewport");
    evidence.push(await captureDomEvidence(context.document, "initial_viewport"));

    const scrollContainer = findScrollContainer(context.document);
    const scrollContainerObservation = describeElement(scrollContainer);
    const initiallyExpanded = await expandCollapsedMessages(context.document);
    if (initiallyExpanded > 0) {
      await addScreenshot(context, evidence, "uncertainty", { reason: "collapsed_content_expanded", count: initiallyExpanded });
      evidence.push(await captureDomEvidence(context.document, "uncertainty"));
    }
    const initial = await observeViewport(context.document);
    accumulator.observe(initial.messages);
    collectBranchIndicators(context.document, observedBranchIndicators);
    const initialCount = accumulator.size;

    context.onProgress("Loading earlier accessible messages");
    const upward = await scrollUntilStable(scrollContainer, -1, accumulator, context, observedBranchIndicators);
    if (upward.boundary) {
      await addScreenshot(context, evidence, "earliest_boundary");
      evidence.push(await captureDomEvidence(context.document, "earliest_boundary"));
    }

    context.onProgress("Loading later accessible messages");
    const downward = await scrollUntilStable(scrollContainer, 1, accumulator, context, observedBranchIndicators);
    if (downward.boundary) {
      await addScreenshot(context, evidence, "latest_boundary");
      evidence.push(await captureDomEvidence(context.document, "latest_boundary"));
    }

    context.onProgress("Inspecting existing response alternatives");
    const traversedBranches = await traverseExistingBranches(context, accumulator, evidence);
    collectBranchIndicators(context.document, observedBranchIndicators);
    const branches = reconcileObservedBranches(traversedBranches, observedBranchIndicators);
    const accumulated = accumulator.finalize();
    warnings.push(...upward.warnings, ...downward.warnings, ...accumulated.warnings);
    const attachments = extractAttachments(accumulated.messages);
    const citations = extractCitations(accumulated.messages);
    const artifacts = extractArtifacts(accumulated.messages);
    if (artifacts.length > 0) {
      await addScreenshot(context, evidence, "artifact", { artifact_count: artifacts.length });
      evidence.push(await captureDomEvidence(context.document, "artifact"));
    }
    const truncationIndicators = findTruncationIndicators(context.document);
    if (truncationIndicators.length > 0) {
      await addScreenshot(context, evidence, "truncation");
      evidence.push(await captureDomEvidence(context.document, "truncation"));
    }

    const checks: VerificationCheck[] = [
      check("boundary.earliest", upward.boundary, "Earliest accessible boundary reached and stabilized."),
      check("boundary.latest", downward.boundary, "Latest accessible boundary reached and stabilized."),
      check("scroll.stabilized", upward.stable && downward.stable, "Scrolling stabilized in both directions."),
      check("count.stabilized", upward.stable && downward.stable, `Accumulated message count stabilized at ${accumulated.messages.length} (initially ${initialCount}).`),
      check("content.not_truncated", truncationIndicators.length === 0, truncationIndicators.length === 0 ? "No visible truncation, incomplete-generation, or expand-content indicator remained." : `${truncationIndicators.length} truncation or incomplete-generation indicators remained after expansion attempts.`),
    ];

    return {
      messages: accumulated.messages,
      branches,
      attachments,
      citations,
      artifacts,
      toolEvents: [],
      evidence,
      loadResult: {
        earliestBoundaryReached: upward.boundary,
        latestBoundaryReached: downward.boundary,
        scrollingStabilized: upward.stable && downward.stable,
        messageCountStabilized: upward.stable && downward.stable,
        observations: upward.passes + downward.passes + 1,
        warnings,
        checks,
      },
      platformMetadata: {
        initial_message_count: initialCount,
        accumulated_message_count: accumulated.messages.length,
        virtualized_dom_accumulation: true,
        scroll_container: scrollContainerObservation,
        upward_scroll_metrics: upward.metrics,
        downward_scroll_metrics: downward.metrics,
        collapsed_messages_expanded: initiallyExpanded + upward.expanded + downward.expanded,
        observed_branch_indicators: [...observedBranchIndicators.values()],
        truncation_indicators: truncationIndicators,
        source_markdown_available: false,
        source_markdown_note: "ChatGPT rendered DOM does not expose original Markdown source; exact accessible rendered wording and structure were preserved.",
      },
    };
  }
}

async function scrollUntilStable(container: HTMLElement, direction: -1 | 1, accumulator: MessageAccumulator, context: AdapterContext, observedBranches: Map<string, ObservedBranchIndicator>) {
  let stablePasses = 0;
  let previousCount = accumulator.size;
  let previousScrollHeight = container.scrollHeight;
  const warnings: string[] = [];
  const metrics: Array<Record<string, unknown>> = [];
  let expanded = 0;
  const scrollStep = Math.max(container.clientHeight * 0.8, 400);
  let passBudget = scrollPassBudget(container.scrollHeight, scrollStep);
  for (let pass = 1; pass <= passBudget; pass += 1) {
    context.signal?.throwIfAborted();
    const before = container.scrollTop;
    container.scrollBy({ top: direction * scrollStep, behavior: "auto" });
    await waitForQuietDom(context.document, 350, 2_000);
    const expandedThisPass = await expandCollapsedMessages(context.document);
    expanded += expandedThisPass;
    if (expandedThisPass > 0) await waitForQuietDom(context.document, 250, 1_500);
    const observed = await observeViewport(context.document);
    accumulator.observe(observed.messages);
    collectBranchIndicators(context.document, observedBranches);
    warnings.push(...observed.warnings);
    const tolerance = Math.max(4, Math.min(64, container.clientHeight * 0.02));
    const remaining = container.scrollHeight - container.clientHeight - container.scrollTop;
    const atBoundary = direction < 0 ? container.scrollTop <= tolerance : remaining <= tolerance;
    const countUnchanged = accumulator.size === previousCount;
    const scrollHeightUnchanged = container.scrollHeight === previousScrollHeight;
    const progressMade = !countUnchanged || !scrollHeightUnchanged || container.scrollTop !== before || expandedThisPass > 0;
    stablePasses = atBoundary && countUnchanged && scrollHeightUnchanged && expandedThisPass === 0 ? stablePasses + 1 : 0;
    passBudget = Math.max(passBudget, scrollPassBudget(container.scrollHeight, scrollStep));
    if (progressMade) passBudget = Math.min(EMERGENCY_MAX_SCROLL_PASSES, Math.max(passBudget, pass + MIN_SCROLL_PASSES));
    metrics.push({ pass, pass_budget: passBudget, before_scroll_top: before, after_scroll_top: container.scrollTop, client_height: container.clientHeight, scroll_height: container.scrollHeight, remaining, message_count: accumulator.size, at_boundary: atBoundary, stable_passes: stablePasses, expanded_messages: expandedThisPass });
    if (stablePasses >= STABLE_PASSES) return { boundary: true, stable: true, passes: pass, warnings: unique(warnings), metrics, expanded };
    previousCount = accumulator.size;
    previousScrollHeight = container.scrollHeight;
    if (pass % 5 === 0) context.onProgress(`Observed ${accumulator.size} unique message nodes after ${pass} ${direction < 0 ? "upward" : "downward"} passes`);
  }
  warnings.push(`Dynamic ${direction < 0 ? "upward" : "downward"} scroll budget of ${passBudget} passes was exhausted without verified stabilization.`);
  return { boundary: false, stable: false, passes: passBudget, warnings: unique(warnings), metrics, expanded };
}

function scrollPassBudget(scrollHeight: number, step: number): number {
  const distanceAware = Math.ceil(scrollHeight / step) * 3 + STABLE_PASSES;
  return Math.min(EMERGENCY_MAX_SCROLL_PASSES, Math.max(MIN_SCROLL_PASSES, distanceAware));
}

async function observeViewport(document: Document): Promise<{ messages: MessageObservation[]; warnings: string[] }> {
  const warnings: string[] = [];
  const elements = findMessageElements(document);
  const seenFallbacks = new Set<string>();
  const messages: MessageObservation[] = [];
  for (const [index, element] of elements.entries()) {
    const role = determineRole(element);
    const platformId = element.getAttribute("data-message-id") ?? element.querySelector("[data-message-id]")?.getAttribute("data-message-id") ?? undefined;
    const locator = platformId ? `chatgpt:message:${platformId}` : `chatgpt:viewport:${index}`;
    const representations = await representationsFor(element, locator);
    const semanticStructureSha256 = await semanticStructureHash(representations.find((item) => item.kind === "sanitized_html")?.value ?? "");
    const fingerprint = await sha256(`${role}\u0000${representations.find((item) => item.kind === "inner_text")?.value ?? ""}\u0000${representations.find((item) => item.kind === "sanitized_html")?.value ?? ""}`);
    const fallbackKey = `fallback-${fingerprint}`;
    if (!platformId && seenFallbacks.has(fallbackKey)) warnings.push("Two visible messages had identical fallback fingerprints; stable platform message identifiers were unavailable.");
    seenFallbacks.add(fallbackKey);
    const observationKey = platformId ?? fallbackKey;
    messages.push({
      observation_key: observationKey,
      message_id: platformId ?? observationKey,
      ...(platformId ? { platform_message_id: platformId } : {}),
      role,
      representations,
      content_blocks: await extractContentBlocks(element, locator),
      evidence_locators: [locator],
      observed_at: new Date().toISOString(),
      platform_metadata: { dom_index_at_observation: index, stable_platform_id_available: Boolean(platformId), semantic_structure_sha256: semanticStructureSha256 },
    });
  }
  return { messages, warnings };
}

function findMessageElements(document: Document): HTMLElement[] {
  for (const selector of MESSAGE_SELECTORS) {
    const found = [...document.querySelectorAll<HTMLElement>(selector)];
    if (found.length > 0) {
      return found.filter((element) => !found.some((candidate) => candidate !== element && candidate.contains(element)));
    }
  }
  return [];
}

function determineRole(element: HTMLElement): MessageRole {
  const role = element.getAttribute("data-message-author-role") ?? element.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role");
  if (role === "user" || role === "assistant" || role === "tool") return role;
  const testId = element.getAttribute("data-testid") ?? "";
  if (/user/i.test(testId)) return "user";
  if (/assistant/i.test(testId)) return "assistant";
  return "unknown";
}

async function representationsFor(element: HTMLElement, locator: string): Promise<PreservedRepresentation[]> {
  const innerText = element.innerText;
  const textContent = element.textContent ?? "";
  const html = sanitizedHtml(element);
  const canonicalText = innerText;
  return Promise.all([
    representation("inner_text", innerText, "HTMLElement.innerText", locator),
    representation("text_content", textContent, "Node.textContent", locator),
    representation("sanitized_html", html, "sanitized cloned outerHTML", locator),
    representation("canonical_text", canonicalText, "verbatim innerText canonical projection", locator),
  ]);
}

async function representation(kind: PreservedRepresentation["kind"], value: string, extractionMethod: string, locator: string): Promise<PreservedRepresentation> {
  return { kind, value, sha256: await sha256(value), extraction_method: extractionMethod, evidence_locator: locator };
}

async function extractContentBlocks(message: HTMLElement, locator: string): Promise<ContentBlock[]> {
  const root = message.querySelector<HTMLElement>(".markdown, [class*='markdown'], [data-message-content]") ?? message;
  const candidates = [...root.querySelectorAll<HTMLElement>("p,h1,h2,h3,h4,h5,h6,pre,ul,ol,blockquote,table,a,img,figure")]
    .filter((element) => !element.parentElement?.closest("p,h1,h2,h3,h4,h5,h6,pre,ul,ol,blockquote,table,a,figure") || element.parentElement?.closest("p,h1,h2,h3,h4,h5,h6,pre,ul,ol,blockquote,table,a,figure") === element);
  const blocks: ContentBlock[] = [];
  for (const [sequence, element] of candidates.entries()) {
    const blockLocator = `${locator}:block:${sequence}`;
    blocks.push({
      block_id: await sha256(`${blockLocator}\u0000${element.tagName}`),
      type: blockType(element),
      sequence,
      representations: await representationsFor(element, blockLocator),
      attributes: extractAttributes(element),
      platform_metadata: { tag_name: element.tagName.toLowerCase() },
    });
  }
  return blocks;
}

function blockType(element: HTMLElement): ContentBlock["type"] {
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "p") return "paragraph";
  if (tag === "pre") return "code";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "blockquote") return "blockquote";
  if (tag === "table") return "table";
  if (tag === "a") return "link";
  if (tag === "img") return "image_reference";
  if (tag === "figure") return "artifact_reference";
  return "unknown";
}

function extractAttributes(element: HTMLElement): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (element instanceof HTMLAnchorElement) result.href = element.href;
  if (element instanceof HTMLImageElement) { result.src = element.currentSrc || element.src; result.alt = element.alt; }
  if (element instanceof HTMLOListElement) result.start = element.start;
  const code = element.matches("pre") ? element.querySelector("code") : null;
  if (code) result.code_class = code.className;
  return result;
}

function sanitizedHtml(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script,style,noscript,iframe,object,embed,input,textarea,select,button").forEach((node) => node.remove());
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || ["srcdoc", "nonce", "integrity", "value"].includes(attribute.name.toLowerCase())) node.removeAttribute(attribute.name);
    }
  }
  return clone.outerHTML;
}

async function semanticStructureHash(html: string): Promise<string> {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const allowedAttributes = new Set(["href", "src", "alt", "title", "start", "rowspan", "colspan", "data-language", "data-writing-block-fullscreen-editor-region", "contenteditable"]);
  const project = (node: Node): unknown => {
    if (node.nodeType === Node.TEXT_NODE) return { text: node.nodeValue ?? "" };
    if (!(node instanceof Element)) return undefined;
    const attributes = [...node.attributes]
      .filter((attribute) => allowedAttributes.has(attribute.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((attribute) => [attribute.name, attribute.value]);
    return { tag: node.tagName.toLowerCase(), attributes, children: [...node.childNodes].map(project).filter((item) => item !== undefined) };
  };
  return sha256(JSON.stringify([...parsed.body.childNodes].map(project).filter((item) => item !== undefined)));
}

function findScrollContainer(document: Document): HTMLElement {
  const messages = findMessageElements(document);
  const first = messages[0];
  const last = messages.at(-1);
  const candidates: HTMLElement[] = [];
  let current = first?.parentElement;
  while (current) {
    const style = getComputedStyle(current);
    if (current.scrollHeight > current.clientHeight + 20 && /(auto|scroll)/.test(style.overflowY) && (!last || current.contains(last))) candidates.push(current);
    current = current.parentElement;
  }
  candidates.sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));
  if (candidates[0]) return candidates[0];
  return document.scrollingElement as HTMLElement ?? document.documentElement;
}

function describeElement(element: HTMLElement): Record<string, unknown> {
  return {
    tag_name: element.tagName.toLowerCase(),
    id: element.id || undefined,
    data_testid: element.getAttribute("data-testid") ?? undefined,
    class_name: element.className,
    client_height: element.clientHeight,
    scroll_height: element.scrollHeight,
    initial_scroll_top: element.scrollTop,
  };
}

async function waitForQuietDom(document: Document, quietMs: number, maximumMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let quietTimer = window.setTimeout(done, quietMs);
    const maximumTimer = window.setTimeout(done, maximumMs);
    const observer = new MutationObserver(() => {
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(done, quietMs);
    });
    function done() { observer.disconnect(); window.clearTimeout(quietTimer); window.clearTimeout(maximumTimer); resolve(); }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

async function captureDomEvidence(document: Document, portion: EvidenceRecord["portion"]): Promise<EvidenceRecord> {
  const main = document.querySelector<HTMLElement>("main") ?? document.body;
  const html = sanitizedHtml(main);
  return { evidence_id: crypto.randomUUID(), kind: "sanitized_dom", portion, captured_at: new Date().toISOString(), media_type: "text/html", sha256: await sha256(html), inline_data: html, metadata: { scope: main.tagName.toLowerCase() } };
}

async function addScreenshot(context: AdapterContext, evidence: EvidenceRecord[], portion: EvidenceRecord["portion"], metadata: Record<string, unknown> = {}): Promise<void> {
  const screenshot = await context.captureScreenshot(portion, metadata);
  if (screenshot) evidence.push(screenshot);
}

async function traverseExistingBranches(context: AdapterContext, accumulator: MessageAccumulator, evidence: EvidenceRecord[]): Promise<BranchRecord[]> {
  const groups = branchGroups(context.document);
  const branches: BranchRecord[] = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const initial = branchGroups(context.document)[groupIndex];
    if (!initial) continue;
    const branch: BranchRecord = { branch_id: branchIndicatorKey(initial), alternative_message_ids: [], ...(initial.total ? { indicated_alternative_count: initial.total } : {}), captured_alternative_count: 0, ...(initial.current ? { initially_active_index: initial.current } : {}), restored_initial_state: false, navigation_log: [], status: "indicated_not_traversed" };
    if (!initial.current || !initial.total) {
      branch.navigation_log.push({ at: new Date().toISOString(), action: "inspect", result: "Alternative controls found but counter could not be parsed safely." });
      branches.push(branch);
      await addScreenshot(context, evidence, "uncertainty", { branch_id: branch.branch_id });
      continue;
    }
    const observed = new Set<string>();
    const initialViewport = await observeViewport(context.document);
    const initialAlternative = annotateBranchObservation(context.document, initial, branch, initialViewport.messages);
    accumulator.observe(initialViewport.messages);
    observed.add(initialAlternative);
    let safe = true;
    for (let index = initial.current; index > 1; index -= 1) safe = (await clickBranchButton(context.document, groupIndex, "previous", branch, accumulator, observed)) && safe;
    for (let index = 1; index < initial.total; index += 1) safe = (await clickBranchButton(context.document, groupIndex, "next", branch, accumulator, observed)) && safe;
    for (let index = initial.total; index > initial.current; index -= 1) safe = (await clickBranchButton(context.document, groupIndex, "previous", branch, accumulator, observed)) && safe;
    const restored = branchGroups(context.document)[groupIndex]?.current === initial.current;
    branch.restored_initial_state = restored;
    branch.alternative_message_ids = [...observed];
    branch.captured_alternative_count = observed.size;
    branch.status = safe && restored && observed.size >= initial.total && [...observed].every((id) => !id.startsWith("unidentified:")) ? "captured" : "partial";
    await addScreenshot(context, evidence, branch.status === "captured" ? "branch" : "uncertainty", { branch_id: branch.branch_id, status: branch.status });
    branches.push(branch);
  }
  return branches;
}

type BranchGroup = { container: HTMLElement; current?: number; total?: number; previous?: HTMLButtonElement; next?: HTMLButtonElement };

function branchGroups(document: Document): BranchGroup[] {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) => branchDirection(button) === "previous");
  const containers: HTMLElement[] = [];
  for (const button of buttons) {
    const container = findBranchNavigationContainer(button);
    if (container && !containers.includes(container)) containers.push(container);
  }
  return containers.map((container) => {
    const match = container.innerText.match(/(\d+)\s*\/\s*(\d+)/);
    const previous = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => branchDirection(button) === "previous");
    const next = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => branchDirection(button) === "next");
    return { container, ...(match?.[1] ? { current: Number(match[1]) } : {}), ...(match?.[2] ? { total: Number(match[2]) } : {}), ...(previous ? { previous } : {}), ...(next ? { next } : {}) };
  });
}

function findBranchNavigationContainer(button: HTMLButtonElement): HTMLElement | undefined {
  let current = button.parentElement;
  for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
    const controls = [...current.querySelectorAll<HTMLButtonElement>("button")];
    const hasPrevious = controls.some((control) => branchDirection(control) === "previous");
    const hasNext = controls.some((control) => branchDirection(control) === "next");
    if (hasPrevious && hasNext && /(\d+)\s*\/\s*(\d+)/.test(current.innerText)) return current;
  }
  return button.parentElement ?? undefined;
}

function branchDirection(button: HTMLButtonElement): "previous" | "next" | undefined {
  const label = `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${button.dataset.testid ?? ""}`.trim();
  if (/^previous\b/i.test(label) && /(response|branch|message|prompt|version)/i.test(label)) return "previous";
  if (/^next\b/i.test(label) && /(response|branch|message|prompt|version)/i.test(label)) return "next";
  return undefined;
}

function branchIndicatorKey(group: BranchGroup): string {
  const message = branchMessageElement(group);
  const messageId = message?.getAttribute("data-message-id") ?? message?.querySelector("[data-message-id]")?.getAttribute("data-message-id") ?? message?.getAttribute("data-turn-id") ?? "unidentified";
  return `chatgpt-branch:${messageId}:${group.total ?? "unknown"}`;
}

function collectBranchIndicators(document: Document, target: Map<string, ObservedBranchIndicator>): void {
  for (const group of branchGroups(document)) {
    const key = branchIndicatorKey(group);
    const message = branchMessageElement(group);
    const messageId = message?.getAttribute("data-message-id") ?? message?.querySelector("[data-message-id]")?.getAttribute("data-message-id") ?? message?.getAttribute("data-turn-id") ?? undefined;
    const existing = target.get(key);
    target.set(key, { key, ...(group.current ? { current: group.current } : existing?.current ? { current: existing.current } : {}), ...(group.total ? { total: group.total } : existing?.total ? { total: existing.total } : {}), ...(messageId ? { message_id: messageId } : {}), observed_at: new Date().toISOString() });
  }
}

function reconcileObservedBranches(traversed: BranchRecord[], observed: Map<string, ObservedBranchIndicator>): BranchRecord[] {
  const results = [...traversed];
  for (const indicator of observed.values()) {
    if (results.some((branch) => branch.branch_id === indicator.key)) continue;
    results.push({
      branch_id: indicator.key,
      alternative_message_ids: [],
      ...(indicator.total ? { indicated_alternative_count: indicator.total } : {}),
      captured_alternative_count: 0,
      ...(indicator.current ? { initially_active_index: indicator.current } : {}),
      restored_initial_state: true,
      navigation_log: [{ at: indicator.observed_at, action: "observe", result: "Existing alternatives were indicated during scrolling but were not traversed." }],
      status: "indicated_not_traversed",
    });
  }
  return results;
}

async function clickBranchButton(document: Document, groupIndex: number, direction: "previous" | "next", branch: BranchRecord, accumulator: MessageAccumulator, observed: Set<string>): Promise<boolean> {
  const button = branchGroups(document)[groupIndex]?.[direction];
  if (!button || button.disabled) {
    branch.navigation_log.push({ at: new Date().toISOString(), action: direction, result: "Control unavailable or disabled." });
    return false;
  }
  button.click();
  await waitForQuietDom(document, 400, 3_000);
  const viewport = await observeViewport(document);
  const refreshed = branchGroups(document)[groupIndex];
  if (refreshed) observed.add(annotateBranchObservation(document, refreshed, branch, viewport.messages));
  accumulator.observe(viewport.messages);
  branch.navigation_log.push({ at: new Date().toISOString(), action: direction, result: "Existing alternative navigation clicked; viewport accumulated." });
  return true;
}

function annotateBranchObservation(document: Document, group: BranchGroup, branch: BranchRecord, observations: MessageObservation[]): string {
  const message = branchMessageElement(group);
  const messageId = message?.getAttribute("data-message-id") ?? message?.querySelector("[data-message-author-role='assistant'][data-message-id], [data-message-id]")?.getAttribute("data-message-id") ?? undefined;
  const orderedElements = findMessageElements(document);
  const messageIndex = message ? orderedElements.findIndex((element) => element === message || element.contains(message) || message.contains(element)) : -1;
  const parentElement = messageIndex > 0 ? orderedElements[messageIndex - 1] : undefined;
  const parentId = parentElement?.getAttribute("data-message-id") ?? parentElement?.querySelector("[data-message-id]")?.getAttribute("data-message-id") ?? undefined;
  if (parentId) branch.parent_message_id = parentId;
  const observation = messageId ? observations.find((item) => item.message_id === messageId) : undefined;
  if (observation) {
    observation.branch_id = branch.branch_id;
    if (parentId) observation.parent_message_id = parentId;
  }
  return messageId ?? `unidentified:${group.current ?? "unknown"}`;
}

function branchMessageElement(group: BranchGroup): HTMLElement | undefined {
  return group.container.closest<HTMLElement>("article, [data-message-author-role], [data-message-id]") ?? group.container.parentElement?.closest<HTMLElement>("article, [data-message-author-role], [data-message-id]") ?? undefined;
}

function extractAttachments(messages: CanonicalMessage[]): AttachmentReference[] {
  const results: AttachmentReference[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const htmlValues = message.representations.filter((item) => item.kind === "sanitized_html").map((item) => item.value);
    for (const html of htmlValues) {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const fileTiles = [...parsed.querySelectorAll<HTMLElement>("[class*='file-tile'][aria-label]")];
      for (const tile of fileTiles) {
        const filename = tile.getAttribute("aria-label") ?? undefined;
        const sourceReference = tile.querySelector<HTMLAnchorElement>("a[href]")?.getAttribute("href") ?? undefined;
        const key = `${message.message_id}:file:${filename ?? sourceReference ?? fileTiles.indexOf(tile)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          attachment_id: key,
          related_message_id: message.message_id,
          kind: message.role === "user" ? "uploaded_file" : "generated_file",
          ...(filename ? { filename } : {}),
          ...(sourceReference ? { source_reference: sourceReference } : {}),
          availability: "referenced",
          evidence_locator: message.evidence_locators[0] ?? "unknown",
          platform_metadata: { bytes_downloaded: false, reference_present: Boolean(sourceReference), visible_label: tile.textContent ?? "" },
        });
      }
      const images = [...parsed.querySelectorAll<HTMLImageElement>("img[src]")];
      for (const image of images) {
        const sourceReference = image.getAttribute("src") ?? undefined;
        const filename = image.getAttribute("alt") || image.getAttribute("aria-label") || undefined;
        const key = `${message.message_id}:image:${sourceReference ?? images.indexOf(image)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          attachment_id: key,
          related_message_id: message.message_id,
          kind: message.role === "user" ? "uploaded_image" : "generated_image",
          ...(filename ? { filename } : {}),
          ...(sourceReference ? { source_reference: sourceReference } : {}),
          availability: "referenced",
          evidence_locator: message.evidence_locators[0] ?? "unknown",
          platform_metadata: { bytes_downloaded: false, reference_present: Boolean(sourceReference) },
        });
      }
    }
  }
  return results;
}

function extractCitations(messages: CanonicalMessage[]): Array<Record<string, unknown>> {
  const citations: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const representation of message.representations.filter((item) => item.kind === "sanitized_html")) {
      const parsed = new DOMParser().parseFromString(representation.value, "text/html");
      const links = [...parsed.querySelectorAll<HTMLAnchorElement>("a[href]")].filter((link) => !link.closest("[class*='file-tile']"));
      for (const [index, link] of links.entries()) {
        const href = link.getAttribute("href") ?? "";
        const label = link.textContent ?? "";
        const key = `${message.message_id}:${href}:${label}`;
        if (!href || seen.has(key)) continue;
        seen.add(key);
        citations.push({ citation_id: `${message.message_id}:link:${index}`, related_message_id: message.message_id, label, href, evidence_locator: `${message.evidence_locators[0] ?? "unknown"}:link:${index}` });
      }
    }
  }
  return citations;
}

function extractArtifacts(messages: CanonicalMessage[]): Array<Record<string, unknown>> {
  const artifacts: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const structural = message.representations.filter((item) => item.kind === "sanitized_html");
    const hasWritingBlock = structural.some((item) => new DOMParser().parseFromString(item.value, "text/html").querySelector("[data-writing-block-fullscreen-editor-region='true']"));
    const artifactBlocks = message.content_blocks.filter((block) => block.type === "artifact_reference");
    if (!hasWritingBlock && artifactBlocks.length === 0) continue;
    artifacts.push({
      artifact_id: `${message.message_id}:chatgpt-writing-block`,
      related_message_id: message.message_id,
      kind: hasWritingBlock ? "chatgpt_writing_block" : "unknown",
      availability: "accessible",
      evidence_locator: message.evidence_locators[0] ?? "unknown",
      content_block_ids: message.content_blocks.map((block) => block.block_id),
      representation_hashes: message.representations.map((item) => ({ kind: item.kind, sha256: item.sha256 })),
      platform_metadata: { contenteditable_surface_observed: hasWritingBlock },
    });
  }
  return artifacts;
}

function check(check_id: string, pass: boolean, message: string): VerificationCheck {
  return { check_id, status: pass ? "pass" : "fail", severity: "material", message, evidence: [] };
}

async function expandCollapsedMessages(document: Document): Promise<number> {
  let expanded = 0;
  const roots = [...document.querySelectorAll<HTMLElement>("[data-testid='collapsible-user-message-root'][data-can-expand]")];
  for (const root of roots) {
    const button = [...root.querySelectorAll<HTMLButtonElement>("button, [role='button']")].find((candidate) => /show more|expand/i.test(`${candidate.innerText} ${candidate.getAttribute("aria-label") ?? ""}`));
    if (!button) continue;
    button.click();
    expanded += 1;
  }
  if (expanded > 0) await waitForQuietDom(document, 250, 1_500);
  return expanded;
}

function findTruncationIndicators(document: Document): Array<Record<string, unknown>> {
  const messageRoots = findMessageElements(document);
  const results: Array<Record<string, unknown>> = [];
  for (const root of messageRoots) {
    const messageId = root.getAttribute("data-message-id") ?? root.querySelector("[data-message-id]")?.getAttribute("data-message-id") ?? undefined;
    for (const element of root.querySelectorAll<HTMLElement>("button, [role='button']")) {
      const label = `${element.innerText} ${element.getAttribute("aria-label") ?? ""}`.trim();
      const insideCollapsibleUserMessage = Boolean(element.closest("[data-testid='collapsible-user-message-root'][data-can-expand]"));
      const kind = /continue generating|resume generating/i.test(label) ? "incomplete_generation" : insideCollapsibleUserMessage && /show more|expand/i.test(label) ? "collapsed_user_message" : undefined;
      if (kind) results.push({ kind, ...(messageId ? { message_id: messageId } : {}), label, aria_label: element.getAttribute("aria-label"), data_testid: element.getAttribute("data-testid") });
    }
  }
  return results;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
