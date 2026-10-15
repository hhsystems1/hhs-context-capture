// Bound connection and response-body reads without changing the model policy.
export function providerRequestSignal(env = process.env) {
  const milliseconds = Number(env.HHS_RECONSTRUCTION_REQUEST_TIMEOUT_MS ?? 240000);
  if (!Number.isInteger(milliseconds) || milliseconds < 1000 || milliseconds > 900000) {
    throw new Error("HHS_RECONSTRUCTION_REQUEST_TIMEOUT_MS must be 1000..900000.");
  }
  return globalThis.AbortSignal.timeout(milliseconds);
}

// The model needs exact text, authorship/order and citation references. Storage
// paths, database IDs and repeated hashes remain in the trusted local exchange;
// sending them for every content block inflated small conversations past context.
// Never mutate/truncate that exchange: validation/persistence still use it whole.
export function modelDiscoveryExchange(exchange) {
  const refs = discoveryAliases(exchange);
  return {
    schema_version: exchange.schema_version,
    pipeline_version: exchange.pipeline_version,
    exchange_id: exchange.exchange_id,
    selection: exchange.selection.map(row => ({
      source_conversation_id: row.source_conversation_id, title: row.title,
      message_count: row.message_count, content_characters: row.content_characters
    })),
    evidence: exchange.evidence.map(row => ({
      evidence_ref: refs.get(row.evidence_ref),
      message_sequence: row.message_sequence, role: row.role, active_path: row.active_path,
      block_kind: row.block_kind, representation_kind: row.representation_kind, text: row.text
    })),
    model_instructions: exchange.model_instructions
  };
}

function discoveryAliases(exchange) {
  const originals = new Set(exchange.evidence.map(row => row.evidence_ref));
  let prefix = 'E';
  while (exchange.evidence.some((_, index) => originals.has(`${prefix}${index + 1}`))) prefix = `_${prefix}`;
  return new Map(exchange.evidence.map((row, index) => [row.evidence_ref, `${prefix}${index + 1}`]));
}

// Expand only issued aliases back to immutable canonical references, before the
// existing validator. Unknown references remain invalid; no evidence is created.
export function restoreModelEvidenceRefs(candidate, exchange) {
  if (!candidate || !Array.isArray(candidate.observations)) return candidate;
  const originalByAlias = new Map([...discoveryAliases(exchange)].map(([original, alias]) => [alias, original]));
  return { ...candidate, observations: candidate.observations.map(row => {
    if (!row || !Array.isArray(row.evidence)) return row;
    return { ...row, evidence: row.evidence.map(cite => {
      if (typeof cite === 'string') return originalByAlias.get(cite) ?? cite;
      if (!cite || typeof cite !== 'object') return cite;
      return { ...cite, evidence_ref: originalByAlias.get(cite.evidence_ref) ?? cite.evidence_ref };
    }) };
  }) };
}

// Safe diagnostics only: never retain echoed provider messages/prompt text/keys.
export function providerFailureCategory(status, message) {
  if (/context.{0,30}(length|limit)|too many tokens|reduce.{0,30}(length|tokens)/i.test(String(message))) return 'context_limit';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'provider_auth';
  if (status === 402) return 'provider_credit';
  return 'provider_error';
}
