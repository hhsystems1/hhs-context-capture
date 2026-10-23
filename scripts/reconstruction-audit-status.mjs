import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const phases = ['pending', 'validating', 'coherence', 'passed', 'review_required', 'failed', 'no_saved_findings'];
export function auditStatusFromSession(workspace, operation, state, audit) {
  if (audit && audit.operation_id !== operation) throw new Error('Audit operation mismatch');
  const flags = audit?.sources?.flatMap(source => source.flags ?? []) ?? [];
  const issues = [...flags, ...(audit?.semantic?.issues ?? [])];
  const blocked = issues.some(issue => issue.severity === 'blocking');
  const checkedFindings = (audit?.sources ?? []).reduce((sum, source) => sum + source.all_findings_persisted_match, 0);
  const phase = audit ? blocked || audit.semantic?.verdict === 'review_required' ? 'review_required' : checkedFindings === 0 ? 'no_saved_findings'
    : checkedFindings > 0 && audit.semantic?.verdict !== 'pass' ? 'failed' : 'passed'
    : state.status === 'auditing' ? state.current_stage === 'coherence_review' ? 'coherence' : 'validating'
    : state.status === 'paused_for_audit' ? 'failed' : 'pending';
  return { workspace, operation_id: operation, phase, updated_at: new Date().toISOString(),
    continuation: !state.audit_only && !state.single_batch && ['waiting_for_batch', 'auditing', 'launching_next_batch', 'cooling_down'].includes(state.status) && (!audit || audit.next_batch_allowed) ? 'automatic' : 'paused',
    checked_findings: checkedFindings,
    sampled_findings: audit?.semantic?.sample_count ?? 0,
    advisory_issues: issues.filter(issue => issue.severity === 'advisory').length,
    blocking_issues: issues.filter(issue => issue.severity === 'blocking').length };
}
function checked(value, workspace, operation) {
  if (!value || value.workspace !== workspace || value.operation_id !== operation
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspace) || !/^operation_[0-9a-f]{32}$/.test(operation)
    || !phases.includes(value.phase) || !['automatic', 'paused'].includes(value.continuation)
    || !Number.isFinite(Date.parse(value.updated_at))) throw new Error('Invalid audit status');
  const result = { operation_id: operation, phase: value.phase, continuation: value.continuation, updated_at: value.updated_at };
  for (const key of ['checked_findings', 'sampled_findings', 'advisory_issues', 'blocking_issues']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error('Invalid audit count');
    result[key] = value[key];
  }
  return result;
}

// A scoped operation receipt, never approved knowledge or a second work queue.
export function publishAuditStatus(root, value) {
  const safe = checked(value, value.workspace, value.operation_id);
  const directory = path.join(root, '.runtime/reconstruction/audit-receipts');
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, `${safe.operation_id}.json`);
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify({ workspace: value.workspace, ...safe }) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, destination);
  return safe;
}

export function readAuditStatus(root, workspace, operation) {
  if (!/^operation_[0-9a-f]{32}$/.test(operation)) throw new Error('Invalid audit operation');
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, '.runtime/reconstruction/audit-receipts', `${operation}.json`), 'utf8'));
    const status = checked(value, workspace, operation);
    const details = cachedReview(root, workspace, operation, status);
    if (!details) return status;
    const previous = readReview(root, workspace, operation, details.revision);
    return { ...status, ...(previous ? { phase: 'reviewed', continuation: 'paused' } : {}),
      review: { ...details, can_acknowledge: details.can_acknowledge && !previous,
        ...(previous ? { recorded_at: previous.recorded_at, rationale: previous.rationale } : {}) } };
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('Audit status unavailable', { cause: error });
  }
}

const sourceId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const reviewPath = (root, operation, revision) => path.join(root, '.runtime/reconstruction/audit-receipts/reviews', `${operation}-${revision}.json`);
function cachedReview(root, workspace, operation, status) {
  const directory = path.join(root, '.runtime/reconstruction/cached-recovery', operation);
  let reportBytes, lineageBytes;
  try { reportBytes = fs.readFileSync(path.join(directory, 'audit.json')); lineageBytes = fs.readFileSync(path.join(directory, 'lineage.json')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const report = JSON.parse(reportBytes), lineage = JSON.parse(lineageBytes);
  if (report.schema_version !== 'hhs-cached-recovery-audit/1' || report.operation_id !== operation
    || lineage.operation_id !== operation || lineage.source !== report.source || !sourceId.test(report.source)
    || !sha.test(lineage.original?.original_input_sha256) || !sha.test(lineage.original?.original_output_sha256)
    || !Number.isSafeInteger(lineage.deferred_links) || lineage.deferred_links < 0 || lineage.deferred_links > 10000
    || !Number.isSafeInteger(report.all_findings_persisted_match) || report.all_findings_persisted_match < 1) throw new Error('Invalid cached audit review');
  const receiptBytes = fs.readFileSync(path.join(root, '.runtime/reconstruction/audit-receipts', `${operation}.json`));
  const revision = createHash('sha256').update(receiptBytes).update(reportBytes).update(lineageBytes).digest('hex');
  const reasons = [
    { code: 'unknown_generator', summary: 'The original generating model is unverified. Findings remain proposed and retain their original source evidence.' },
    { code: 'deferred_relationships', summary: `${lineage.deferred_links} relationships to other conversations are preserved for later review. A batch-wide count in a provisional proposal is also unverified.` },
  ];
  // Only the already-validated cached-recovery advisories can be acknowledged.
  // Failed audits, blocking evidence defects and unknown report forms stay held.
  const can_acknowledge = status.phase === 'review_required' && status.continuation === 'paused'
    && status.blocking_issues === 0 && status.advisory_issues === 2
    && report.phase === 'review_required' && report.original_generator_verified === false
    && lineage.original.generating_model_provenance === 'unverified'
    && report.all_current_evidence_matched === true && report.replay_new_rows === 0
    && report.new_user_authority_risks === 0 && report.missing_provenance === 0
    && report.changed_existing_runtime_files === 0 && Array.isArray(report.artifact_flags) && report.artifact_flags.length === 0
    && report.all_findings_trusted_validated === report.all_findings_persisted_match
    && report.all_findings_persisted_match === status.checked_findings
    && report.prior_user_authority_risks === report.remaining_user_authority_risks
    && report.prior_exact_duplicate_groups === report.remaining_exact_duplicate_groups;
  return { revision, source_conversation_id: report.source, reasons, can_acknowledge };
}
function readReview(root, workspace, operation, revision) {
  let value;
  try { value = JSON.parse(fs.readFileSync(reviewPath(root, operation, revision), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (value.schema_version !== 'hhs-reconstruction-audit-review/1' || value.workspace !== workspace
    || value.operation_id !== operation || value.revision !== revision || !uuid.test(value.reviewer_ref)
    || value.acknowledge_limitations !== true || typeof value.rationale !== 'string'
    || value.rationale.trim().length < 10 || value.rationale.length > 1000 || !Number.isFinite(Date.parse(value.recorded_at))) throw new Error('Invalid audit review receipt');
  return value;
}
// The service supplies authenticated ownership, latest-operation checks and its
// existing global execution exclusion. This function never starts processing,
// edits findings/knowledge, or overwrites the original audit or another review.
export function acknowledgeAuditReview(root, workspace, input) {
  const { operation_id: operation, revision, reviewer_ref, rationale, acknowledge_limitations } = input;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspace) || typeof operation !== 'string' || !/^operation_[0-9a-f]{32}$/.test(operation)
    || typeof revision !== 'string' || !sha.test(revision) || typeof reviewer_ref !== 'string' || !uuid.test(reviewer_ref) || acknowledge_limitations !== true
    || typeof rationale !== 'string' || rationale.trim().length < 10 || rationale.length > 1000
    || Object.keys(input).some(key => !['operation_id','revision','reviewer_ref','rationale','acknowledge_limitations'].includes(key))) throw new Error('invalid_review');
  const raw = JSON.parse(fs.readFileSync(path.join(root, '.runtime/reconstruction/audit-receipts', `${operation}.json`), 'utf8'));
  const status = checked(raw, workspace, operation), details = cachedReview(root, workspace, operation, status);
  if (!details || details.revision !== revision || !details.can_acknowledge) throw new Error('review_changed_or_blocked');
  const previous = readReview(root, workspace, operation, revision);
  if (previous && (previous.reviewer_ref !== reviewer_ref || previous.rationale !== rationale.trim())) throw new Error('review_conflict');
  const receipt = previous ?? { schema_version: 'hhs-reconstruction-audit-review/1', workspace, operation_id: operation, revision,
    reviewer_ref, rationale: rationale.trim(), acknowledge_limitations: true, recorded_at: new Date().toISOString() };
  if (!previous) {
    const destination = reviewPath(root, operation, revision);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return { operation_id: operation, revision, recorded_at: receipt.recorded_at, continuation: 'paused', replay: !!previous };
}
