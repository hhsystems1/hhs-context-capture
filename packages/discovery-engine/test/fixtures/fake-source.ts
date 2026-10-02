import { createHash } from "node:crypto";
import type {
  DiscoveryAdapter,
  DiscoveryPortContext,
  DiscoveryTraversalPort,
  RawContainerObservation,
  RawItemObservation,
  TraversalSnapshot
} from "../../src/adapter-contract.js";

/**
 * A synthetic source with no DOM, no network, and no filesystem. It exists to prove that the
 * discovery engine contains no source-specific behaviour: if the engine can drive this, it can
 * drive a browser, an export archive, or an API with only a different adapter.
 */

const ROW = 40;
const VIEWPORT = 200;

export interface FakeContainerSpec {
  id: string;
  title: string;
  declaredItemCount?: number;
}

export interface FakeItemSpec {
  id: string;
  containerRef: string;
  title: string;
  /** Simulates a source that exposes no stable identity for a row. */
  unstableIdentity?: boolean;
}

export interface FakeSourceOptions {
  containers: FakeContainerSpec[];
  items: FakeItemSpec[];
  /** Simulates a list that keeps growing, so the end boundary is never verified. */
  growingExtent?: boolean;
  /** Simulates a source that reports a different title for the same identity across passes. */
  unstableTitles?: boolean;
  /** Simulates a traversal that refuses to return to its starting position. */
  refuseRestore?: boolean;
}

export function nodeSha256(value: string): Promise<string> {
  return Promise.resolve(createHash("sha256").update(value, "utf8").digest("hex"));
}

export class FakeSourcePort implements DiscoveryTraversalPort {
  private position = 0;
  private inspections = 0;
  private growth = 0;

  constructor(private readonly options: FakeSourceOptions) {}

  inspect(): TraversalSnapshot {
    this.inspections += 1;
    if (this.options.growingExtent) this.growth += ROW;

    const extent = Math.max(this.options.items.length * ROW, VIEWPORT) + this.growth;
    const first = Math.max(0, Math.floor(this.position / ROW));
    const last = Math.min(this.options.items.length, Math.ceil((this.position + VIEWPORT) / ROW));

    const containers: RawContainerObservation[] = this.options.containers.map((container, index) => ({
      source_native_id: container.id,
      container_kind: "folder",
      title: container.title,
      source_url: `fake://container/${container.id}`,
      depth: 0,
      ...(container.declaredItemCount === undefined ? {} : { declared_item_count: container.declaredItemCount }),
      evidence_locator: `fake:container:${container.id}`,
      sanitized_evidence: `<div data-container="${container.id}">${container.title}</div>`,
      order_hint: index,
      source_metadata: { fake: true }
    }));

    const items: RawItemObservation[] = this.options.items.slice(first, last).map((item, offset) => {
      const title = this.options.unstableTitles && this.inspections > 2 ? `${item.title} (changed)` : item.title;
      return {
        ...(item.unstableIdentity ? {} : { source_native_id: item.id }),
        container_ref: item.containerRef,
        item_kind: "conversation",
        title,
        source_url: `fake://item/${item.id}`,
        declared: { modified_at: "2026-08-12T00:00:00.000Z" },
        evidence_class: "original_evidence" as const,
        capture_feasibility: "capturable" as const,
        evidence_locator: `fake:item:${item.id}`,
        sanitized_evidence: `<div data-item="${item.id}">${item.title}</div>`,
        order_hint: (first + offset) * ROW,
        source_metadata: { fake: true }
      };
    });

    return { containers, items, position: this.position, extent, viewport: VIEWPORT };
  }

  seek(position: number): void {
    if (this.options.refuseRestore && position === 0 && this.inspections > 3) return;
    this.position = Math.max(0, position);
  }

  async waitForSettled(): Promise<void> {
    return Promise.resolve();
  }
}

export class FakeSourceAdapter implements DiscoveryAdapter {
  readonly sourceKind = "fake-source";
  readonly adapterId = "fake-source-discovery";
  readonly adapterVersion = "0.1.0";
  readonly transport = "http_api" as const;
  readonly capabilities = {
    containers: "supported" as const,
    items: "supported" as const,
    item_timestamps: "supported" as const,
    versions: "unsupported" as const,
    attachments: "unknown" as const
  };

  constructor(private readonly options: FakeSourceOptions) {}

  identify(context: DiscoveryPortContext) {
    return {
      detected: context.host === "fake.invalid",
      source_kind: this.sourceKind,
      confidence: "high" as const,
      reasons: [`host:${context.host}`]
    };
  }

  async openPort(): Promise<DiscoveryTraversalPort> {
    return new FakeSourcePort(this.options);
  }
}

export function fakeContext(): DiscoveryPortContext {
  return { host: "fake.invalid", url: "https://fake.invalid/list" };
}
