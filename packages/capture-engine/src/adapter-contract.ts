import type {
  AttachmentReference,
  BranchRecord,
  CanonicalMessage,
  EvidenceRecord,
  PlatformId,
  VerificationCheck,
} from "@hhs/canonical-schema";

export interface AdapterContext {
  document: Document;
  sourceUrl: string;
  signal?: AbortSignal;
  captureScreenshot(portion: EvidenceRecord["portion"], metadata?: Record<string, unknown>): Promise<EvidenceRecord | undefined>;
  onProgress(message: string): void;
}

export interface DetectionResult {
  detected: boolean;
  platform: PlatformId;
  confidence: "high" | "medium" | "low";
  reasons: string[];
}

export interface ConversationIdentity {
  conversationId: string;
  platformConversationId?: string;
  title: string;
  sourceUrl: string;
}

export interface LoadResult {
  earliestBoundaryReached: boolean;
  latestBoundaryReached: boolean;
  scrollingStabilized: boolean;
  messageCountStabilized: boolean;
  observations: number;
  warnings: string[];
  checks: VerificationCheck[];
}

export interface ExtractedConversation {
  messages: CanonicalMessage[];
  branches: BranchRecord[];
  attachments: AttachmentReference[];
  citations: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  toolEvents: Array<Record<string, unknown>>;
  evidence: EvidenceRecord[];
  loadResult: LoadResult;
  platformMetadata: Record<string, unknown>;
}

export interface PlatformAdapter {
  readonly platform: PlatformId;
  readonly adapterVersion: string;
  detect(context: AdapterContext): Promise<DetectionResult>;
  identifyConversation(context: AdapterContext): Promise<ConversationIdentity>;
  capture(context: AdapterContext): Promise<ExtractedConversation>;
}

