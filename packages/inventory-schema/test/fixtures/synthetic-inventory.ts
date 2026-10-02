import type { ConversationObservation, InventoryEvidence, InventoryRun } from "../../src/index.js";
import { computeEvidenceHash, computeObservationFingerprint, finalizeInventory } from "../../src/index.js";

const timestamp = "2026-07-17T12:00:00.000Z";

export function syntheticObservation(conversationId: string, title: string, position: number, reviewReasons: string[] = []): ConversationObservation {
  const base = {
    observation_id: `observation-${conversationId}`,
    conversation_id: conversationId,
    platform_conversation_id: `platform-${conversationId}`,
    title,
    source_url: `https://synthetic.invalid/conversation/${conversationId}`,
    sidebar_position: position,
    observed_at: timestamp,
    visible_status_indicators: [],
    evidence_ids: [`evidence-${conversationId}`],
    review_status: reviewReasons.length > 0 ? "needs_review" as const : "clear" as const,
    review_reasons: reviewReasons,
    platform_metadata: { fixture: true }
  };
  return { ...base, observation_fingerprint: computeObservationFingerprint(base) };
}

export function syntheticEvidence(conversationId: string): InventoryEvidence {
  const value = JSON.stringify({ conversation_id: conversationId, source: "synthetic_fixture" });
  return {
    evidence_id: `evidence-${conversationId}`,
    kind: "observation_log",
    media_type: "application/json",
    value,
    sha256: computeEvidenceHash({ value }),
    evidence_locator: `fixture:sidebar:${conversationId}`,
    captured_at: timestamp
  };
}

export function syntheticInventory(inventoryId: string, observations: ConversationObservation[], status: InventoryRun["status"] = "complete"): InventoryRun {
  const complete = status === "complete";
  return finalizeInventory({
    schema_version: "0.1.0",
    inventory_id: inventoryId,
    platform: { platform_id: "synthetic-ai", observed_host: "synthetic.invalid" },
    account: { opaque_account_reference: "opaque-account-fixture-001" },
    started_at: timestamp,
    completed_at: timestamp,
    status,
    boundary_verification: {
      earliest_reached: complete,
      latest_reached: complete,
      scroll_stabilized: complete,
      observation_count_stabilized: complete,
      initial_position_restored: true
    },
    observations,
    evidence: observations.map((item) => syntheticEvidence(item.conversation_id)),
    warnings: complete ? [] : ["synthetic_partial_inventory"]
  });
}
