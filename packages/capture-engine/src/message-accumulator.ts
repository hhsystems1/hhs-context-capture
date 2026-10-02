import type { CanonicalMessage } from "@hhs/canonical-schema";

export interface MessageObservation extends Omit<CanonicalMessage, "sequence" | "observed_at"> {
  observation_key: string;
  observed_at: string;
}

export interface AccumulatorResult {
  messages: CanonicalMessage[];
  warnings: string[];
}

/**
 * Retains observations across scroll passes. Ordering is derived from all
 * observed adjacency edges, so messages that leave a virtualized DOM survive.
 */
export class MessageAccumulator {
  readonly #messages = new Map<string, MessageObservation>();
  readonly #observedTimes = new Map<string, Set<string>>();
  readonly #edges = new Map<string, Set<string>>();
  readonly #warnings = new Set<string>();

  observe(orderedViewportMessages: MessageObservation[]): void {
    for (const observation of orderedViewportMessages) {
      const existing = this.#messages.get(observation.observation_key);
      if (existing) {
        const changedKinds = changedRepresentationKinds(existing, observation);
        if (changedKinds.length > 0) {
          this.#warnings.add(`Message ${observation.observation_key} changed between observations (${changedKinds.join(", ")}); distinct representations were retained for review.`);
          const previous = Array.isArray(existing.platform_metadata.representation_drift_kinds) ? existing.platform_metadata.representation_drift_kinds.filter((item): item is string => typeof item === "string") : [];
          existing.platform_metadata.representation_drift_kinds = [...new Set([...previous, ...changedKinds])];
        }
        mergeObservation(existing, observation);
      } else {
        this.#messages.set(observation.observation_key, structuredClone(observation));
      }
      const times = this.#observedTimes.get(observation.observation_key) ?? new Set<string>();
      times.add(observation.observed_at);
      this.#observedTimes.set(observation.observation_key, times);
    }

    for (let index = 0; index < orderedViewportMessages.length - 1; index += 1) {
      const from = orderedViewportMessages[index]?.observation_key;
      const to = orderedViewportMessages[index + 1]?.observation_key;
      if (!from || !to || from === to) continue;
      const successors = this.#edges.get(from) ?? new Set<string>();
      successors.add(to);
      this.#edges.set(from, successors);
    }
  }

  get size(): number {
    return this.#messages.size;
  }

  finalize(): AccumulatorResult {
    const keys = [...this.#messages.keys()];
    const indegree = new Map(keys.map((key) => [key, 0]));
    for (const successors of this.#edges.values()) {
      for (const successor of successors) {
        if (indegree.has(successor)) indegree.set(successor, (indegree.get(successor) ?? 0) + 1);
      }
    }

    const insertionIndex = new Map(keys.map((key, index) => [key, index]));
    const queue = keys.filter((key) => indegree.get(key) === 0);
    queue.sort((a, b) => (insertionIndex.get(a) ?? 0) - (insertionIndex.get(b) ?? 0));
    const ordered: string[] = [];

    while (queue.length > 0) {
      const key = queue.shift();
      if (!key) break;
      ordered.push(key);
      for (const successor of this.#edges.get(key) ?? []) {
        const next = (indegree.get(successor) ?? 1) - 1;
        indegree.set(successor, next);
        if (next === 0) queue.push(successor);
      }
      queue.sort((a, b) => (insertionIndex.get(a) ?? 0) - (insertionIndex.get(b) ?? 0));
    }

    if (ordered.length !== keys.length) {
      this.#warnings.add("Conflicting ordering observations formed a cycle; unresolved messages use first-observed order.");
      for (const key of keys) if (!ordered.includes(key)) ordered.push(key);
    }

    return {
      messages: ordered.map((key, sequence) => {
        const message = this.#messages.get(key);
        if (!message) throw new Error(`Accumulator invariant failed for ${key}`);
        const { observation_key: _observationKey, observed_at: _observedAt, ...canonical } = message;
        void _observationKey;
        void _observedAt;
        const observedTimes = [...(this.#observedTimes.get(key) ?? [])];
        return {
          ...canonical,
          sequence,
          observed_at: observedTimes.length > 1 ? [observedTimes[0]!, observedTimes.at(-1)!] : observedTimes,
          platform_metadata: {
            ...canonical.platform_metadata,
            observation_count: observedTimes.length,
            first_observed_at: observedTimes[0],
            last_observed_at: observedTimes.at(-1),
          },
        };
      }),
      warnings: [...this.#warnings],
    };
  }
}

function changedRepresentationKinds(left: MessageObservation, right: MessageObservation): string[] {
  const kinds = new Set([...left.representations.map((item) => item.kind), ...right.representations.map((item) => item.kind)]);
  return [...kinds].filter((kind) => {
    const leftHashes = new Set(left.representations.filter((item) => item.kind === kind).map((item) => item.sha256));
    const rightHashes = new Set(right.representations.filter((item) => item.kind === kind).map((item) => item.sha256));
    return leftHashes.size !== rightHashes.size || [...leftHashes].some((hash) => !rightHashes.has(hash));
  });
}

function mergeObservation(target: MessageObservation, source: MessageObservation): void {
  if (source.parent_message_id) target.parent_message_id = source.parent_message_id;
  if (source.branch_id) target.branch_id = source.branch_id;
  const semanticHashes = new Set<string>();
  const existingSemantic = target.platform_metadata.semantic_structure_hashes;
  if (Array.isArray(existingSemantic)) for (const hash of existingSemantic) if (typeof hash === "string") semanticHashes.add(hash);
  if (typeof target.platform_metadata.semantic_structure_sha256 === "string") semanticHashes.add(target.platform_metadata.semantic_structure_sha256);
  if (typeof source.platform_metadata.semantic_structure_sha256 === "string") semanticHashes.add(source.platform_metadata.semantic_structure_sha256);
  target.platform_metadata.semantic_structure_hashes = [...semanticHashes];
  for (const locator of source.evidence_locators) {
    if (!target.evidence_locators.includes(locator)) target.evidence_locators.push(locator);
  }
  for (const representation of source.representations) {
    if (!target.representations.some((item) => item.kind === representation.kind && item.sha256 === representation.sha256)) target.representations.push(structuredClone(representation));
  }
  for (const sourceBlock of source.content_blocks) {
    const targetBlock = target.content_blocks.find((item) => item.block_id === sourceBlock.block_id);
    if (!targetBlock) {
      target.content_blocks.push(structuredClone(sourceBlock));
      continue;
    }
    for (const representation of sourceBlock.representations) {
      if (!targetBlock.representations.some((item) => item.kind === representation.kind && item.sha256 === representation.sha256)) targetBlock.representations.push(structuredClone(representation));
    }
  }
}
