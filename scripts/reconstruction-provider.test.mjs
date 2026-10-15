import { describe, it, expect } from "vitest";
import { modelDiscoveryExchange, restoreModelEvidenceRefs, providerFailureCategory, providerRequestSignal } from "./reconstruction-provider.mjs";
import { setTimeout, clearTimeout } from "node:timers";

describe("bounded reconstruction requests", () => {
  it("preserves every exact evidence text/reference and authorship while keeping trust metadata local", () => {
    const input = { schema_version: "input/1", pipeline_version: "pipeline/1", exchange_id: "exchange-1",
      evidence_sha256: "trusted-exchange-hash", selection: [{ source_conversation_id: "source-1", title: "Sample",
        message_count: 2, content_characters: 40, source_version_id: "private-version", immutable_source_locator: "private-path" }],
      evidence: Array.from({ length: 1342 }, (_, i) => ({ evidence_ref: `evidence-${i}`, source_conversation_id: "source-1",
        message_sequence: i, role: i % 2 ? "assistant" : "user", active_path: i % 3 !== 0,
        block_kind: "text", representation_kind: "canonical_text", text: `Exact text ${i}: café 🙂\n`,
        source_version_id: "private-version", representation_sha256: "a".repeat(64), source_record_sha256: "b".repeat(64),
        resolution_expected_sha256: "c".repeat(64), resolution_observed_sha256: "d".repeat(64),
        immutable_evidence_locator: "private-path".repeat(50), source_version_locator: "private-path".repeat(50) })),
      model_instructions: { evidence_refs_are_authoritative: true } };
    const original = JSON.stringify(input);
    const projected = modelDiscoveryExchange(input);
    expect(JSON.stringify(input)).toBe(original);
    expect(projected.exchange_id).toBe(input.exchange_id);
    expect(projected.evidence.map(row => [row.text, row.role, row.message_sequence, row.active_path]))
      .toEqual(input.evidence.map(row => [row.text, row.role, row.message_sequence, row.active_path]));
    expect(restoreModelEvidenceRefs({ observations: [{ evidence: projected.evidence.map(row => ({ evidence_ref: row.evidence_ref })) }] }, input)
      .observations[0].evidence.map(row => row.evidence_ref)).toEqual(input.evidence.map(row => row.evidence_ref));
    expect(projected.selection[0].source_conversation_id).toBe(input.selection[0].source_conversation_id);
    expect(JSON.stringify(projected)).not.toMatch(/private-path|private-version|resolution_expected_sha256/);
    expect(JSON.stringify(projected).length).toBeLessThan(original.length / 4);
  });
  it("does not turn an unknown alias into evidence or collide with original reference names", () => {
    const input = { evidence: [{ evidence_ref: 'E1', text: 'a' }, { evidence_ref: '_E2', text: 'b' }] };
    const restored = restoreModelEvidenceRefs({ observations: [{ evidence: ['__E1', { evidence_ref: '__E2' }, { evidence_ref: '__E999' }] }] }, input);
    expect(restored.observations[0].evidence).toEqual(['E1', { evidence_ref: '_E2' }, { evidence_ref: '__E999' }]);
  });
  it("records safe provider failure categories without returning echoed sensitive messages", () => {
    expect(providerFailureCategory(400, "maximum context length exceeded; secret source text")).toBe("context_limit");
    expect(providerFailureCategory(429, "secret source text")).toBe("rate_limited");
    expect(providerFailureCategory(401, "secret credential")).toBe("provider_auth");
    expect(providerFailureCategory(402, "secret account")).toBe("provider_credit");
    expect(providerFailureCategory(503, "secret prompt")).toBe("provider_error");
  });
  it("aborts a stalled provider and rejects invalid timeout configuration", async () => {
    const signal = providerRequestSignal({ HHS_RECONSTRUCTION_REQUEST_TIMEOUT_MS: "1000" });
    await expect(new Promise((resolve, reject) => {
      const keepAlive = setTimeout(resolve, 5000);
      signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(signal.reason); });
    })).rejects.toMatchObject({ name: "TimeoutError" });
    for (const value of ["0", "-1", "900001", "abc"]) expect(() => providerRequestSignal({ HHS_RECONSTRUCTION_REQUEST_TIMEOUT_MS: value })).toThrow();
  });
});
