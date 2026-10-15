import fs from 'node:fs';
import path from 'node:path';

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
    continuation: !state.audit_only && ['waiting_for_batch', 'auditing', 'launching_next_batch'].includes(state.status) && (!audit || audit.next_batch_allowed) ? 'automatic' : 'paused',
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
    return checked(value, workspace, operation);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('Audit status unavailable', { cause: error });
  }
}
