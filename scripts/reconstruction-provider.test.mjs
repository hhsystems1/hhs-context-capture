import { describe, it, expect } from "vitest";
import { modelDiscoveryExchange, restoreModelEvidenceRefs, providerFailureCategory, providerRequestSignal, requestDiscoveryModel, modelLinkingObservations, restoreLinkingRefs } from "./reconstruction-provider.mjs";
import { setTimeout, clearTimeout } from "node:timers";

describe("bounded reconstruction requests", () => {
  it('projects relationship inputs without changing observations or guessing unknown references', () => {
    const rows = [{ observation_ref: 'L1', statement: 'A proposal', attribution: { subject: 'assistant', claim_type: 'proposal' }, evidence: [{ evidence_ref: 'private-long-storage-ref' }], payload: { detail: 'preserve' } },
      { observation_ref: 'chunk2__obs', statement: 'A revision', attribution: { subject: 'user', claim_type: 'revision' }, payload: {} }];
    const before = JSON.stringify(rows);
    const projected = modelLinkingObservations(rows);
    expect(projected.map(row => row.observation_ref)).toEqual(['_L1', '_L2']);
    expect(projected[0]).toMatchObject({ statement: rows[0].statement, attribution: rows[0].attribution, payload: rows[0].payload });
    expect(JSON.stringify(projected)).not.toContain('private-long-storage-ref');
    expect(restoreLinkingRefs([{ from_observation_ref: '_L1', to_observation_ref: '_L2' }, { from_observation_ref: '_L999', to_observation_ref: '_L2' }], rows))
      .toEqual([{ from_observation_ref: 'L1', to_observation_ref: 'chunk2__obs' }, { from_observation_ref: '_L999', to_observation_ref: 'chunk2__obs' }]);
    expect(JSON.stringify(rows)).toBe(before);
  });
  const stream = lines => {
    const bytes = new globalThis.TextEncoder().encode(lines.join('\r\n') + '\r\n');
    return new globalThis.Response(new globalThis.ReadableStream({ start(controller) {
      // Fragment UTF-8 and JSON boundaries as a real network connection may.
      for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.slice(index, index + 1));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const call = response => requestDiscoveryModel('synthetic-free', 'system', 'data', { env: {}, fetch: async () => response });
  it("buffers a complete streamed answer without retaining model reasoning", async () => {
    const result = await call(stream([
      ': keepalive',
      'data: ' + JSON.stringify({ id: 'synthetic-id', model: 'synthetic-free', choices: [{ delta: { reasoning: 'private reasoning', content: 'café 🙂' } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: { content: ' done' }, finish_reason: 'stop' }], usage: { cost: 0 } }),
      'data: [DONE]'
    ]));
    expect(result).toMatchObject({ ok: true, content: 'café 🙂 done', data: { choices: [{ finish_reason: 'stop' }] } });
    expect(JSON.stringify(result)).not.toContain('private reasoning');
  });
  it("rejects a provider error after partial streamed output", async () => {
    const result = await call(stream([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '{"observations":[]}' } }] }),
      'data: ' + JSON.stringify({ error: { code: 503, message: 'private echoed source' } })
    ]));
    expect(result).toMatchObject({ ok: false, error: { provider_error_code: 503 } });
    expect(JSON.stringify(result)).not.toMatch(/private echoed source|observations/);
  });
  it("rejects a stream that disconnects without a terminal marker", async () => {
    expect(await call(stream(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })])))
      .toMatchObject({ ok: false, error: { category: 'incomplete_response' } });
  });
  it("preserves truncation for the caller guard and rejects hidden nonzero costs", async () => {
    const truncated = await call(stream(['data: ' + JSON.stringify({ choices: [{ delta: { content: '{}' }, finish_reason: 'length' }] }), 'data: [DONE]']));
    expect(truncated).toMatchObject({ ok: true, data: { choices: [{ finish_reason: 'length' }] } });
    expect(await call(stream([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }], usage: { cost: 1 } }),
      'data: ' + JSON.stringify({ usage: { cost: 0 } }), 'data: [DONE]'
    ]))).toMatchObject({ ok: false, error: { category: 'provider_policy' } });
  });
  it("rejects an error on a non-streaming completion choice", async () => {
    const result = await call({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' }, finish_reason: 'error', error: { code: 502 } }] }) });
    expect(result).toMatchObject({ ok: false, error: { provider_error_code: 502 } });
  });
  it("retains a safe embedded provider error code when the HTTP transport reports success", async () => {
    const attempts = [];
    const result = await requestDiscoveryModel('synthetic-free', 'system', 'data', { env: { OPENROUTER_API_KEY: 'synthetic-key' },
      onAttempt: attempt => attempts.push(attempt),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ error: { code: '429', message: 'private echoed input' } }) }) });
    expect(result).toMatchObject({ ok: false, error: { category: 'rate_limited', http_status: 200, provider_error_code: 429 } });
    expect(attempts).toEqual([result.error]);
    expect(JSON.stringify(result)).not.toContain('private echoed input');
    const unsafe = await requestDiscoveryModel('synthetic-free', 'system', 'data', { env: {},
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ error: { code: 'private secret', message: 'private echoed input' } }) }) });
    expect(unsafe.error).toEqual({ category: 'provider_error', http_status: 200 });
  });
  it("does not multiply a failed provider request into another internal retry loop", async () => {
    let calls = 0;
    const result = await requestDiscoveryModel('synthetic-free', 'system', 'data', { env: { OPENROUTER_API_KEY: 'synthetic-key' },
      fetch: async () => { calls++; return { ok: false, status: 429, json: async () => ({ error: { message: 'private echoed input' } }) }; } });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: false, error: { category: 'rate_limited', http_status: 429 } });
    expect(JSON.stringify(result)).not.toContain('private echoed input');
  });
  it("shares a source deadline across retries and chunks without starting expired requests", async () => {
    let calls = 0;
    const result = await requestDiscoveryModel('synthetic-free', 'system', 'data', { env: {
      OPENROUTER_API_KEY: 'synthetic-key', HHS_RECONSTRUCTION_DEADLINE_AT: String(Date.now() - 1) },
      fetch: async () => { calls++; throw new Error('must not request'); } });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ ok: false, error: { category: 'source_deadline' } });
  });
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
  it("bounds extra relationship anchors across chunks without dropping or mutating retained findings", () => {
    const rows = Array.from({ length: 65 }, (_, index) => ({ observation_ref: `chunk${String(Math.floor(index / 5) + 1).padStart(3, '0')}__o${index}`,
      statement: index % 5 === 4 ? 'User corrected a requirement.' : 'Assistant explored an idea.',
      observation_kind: index % 5 === 4 ? 'correction' : 'proposal', attribution: { subject: index % 5 === 4 ? 'user' : 'assistant' }, evidence: [{ evidence_ref: 'original' }] }));
    const before = JSON.stringify(rows);
    const anchors = modelLinkingObservations(rows, 16);
    expect(anchors).toHaveLength(16);
    const canonical = restoreLinkingRefs(anchors.map(row => ({ from_observation_ref: row.observation_ref, to_observation_ref: row.observation_ref })), rows);
    expect(new Set(canonical.map(row => row.from_observation_ref.match(/^chunk\d+/)[0])).size).toBe(13);
    expect(anchors.filter(row => row.attribution.subject === 'user').length).toBeGreaterThanOrEqual(13);
    expect(JSON.stringify(rows)).toBe(before);
    expect(modelLinkingObservations(rows)).toHaveLength(65);
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
