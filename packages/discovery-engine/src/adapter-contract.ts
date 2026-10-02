import type {
  CapabilitySupport,
  CaptureFeasibility,
  DeclaredItemMetadata,
  EvidenceClass,
  TransportKind
} from "@hhs/discovery-schema";

/**
 * The discovery adapter contract is deliberately transport-agnostic. Nothing in this file
 * references `Document`, the DOM, the filesystem, or the network. A browser adapter receives
 * its root object through the opaque `root` field and narrows it internally; a future export,
 * filesystem, or API adapter uses the same contract without change.
 */

export interface RawContainerObservation {
  source_native_id?: string;
  parent_ref?: string;
  container_kind: string;
  title: string;
  source_url?: string;
  depth: number;
  declared_item_count?: number;
  evidence_locator: string;
  sanitized_evidence: string;
  order_hint: number;
  source_metadata: Record<string, unknown>;
}

export interface RawItemObservation {
  source_native_id?: string;
  /** Identifies which container this item belongs to, matched against a container's `source_native_id`. */
  container_ref: string;
  item_kind: string;
  title: string;
  source_url?: string;
  declared: DeclaredItemMetadata;
  evidence_class: EvidenceClass;
  capture_feasibility: CaptureFeasibility;
  blocked_reason?: string;
  evidence_locator: string;
  sanitized_evidence: string;
  order_hint: number;
  source_metadata: Record<string, unknown>;
}

/** One observation pass over whatever the source currently exposes. */
export interface TraversalSnapshot {
  containers: RawContainerObservation[];
  items: RawItemObservation[];
  /** Current traversal offset (scroll offset, page number, cursor index). */
  position: number;
  /** Total traversable extent, in the same unit as `position`. */
  extent: number;
  /** Size of the currently visible window, in the same unit as `position`. */
  viewport: number;
}

export interface DiscoveryTraversalPort {
  inspect(): TraversalSnapshot;
  seek(position: number): void;
  waitForSettled(): Promise<void>;
}

export interface DiscoveryPortContext {
  host: string;
  url: string;
  /** Opaque source root. Browser adapters narrow this to a `Document`; other transports use their own type. */
  root?: unknown;
}

export interface SourceIdentification {
  detected: boolean;
  source_kind: string;
  confidence: "high" | "medium" | "low";
  reasons: string[];
}

export interface DiscoveryAdapter {
  readonly sourceKind: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly transport: TransportKind;
  /** Per-dimension declaration of what this adapter can observe. Never leave a dimension undeclared. */
  readonly capabilities: Record<string, CapabilitySupport>;
  identify(context: DiscoveryPortContext): SourceIdentification;
  openPort(context: DiscoveryPortContext): Promise<DiscoveryTraversalPort>;
}
