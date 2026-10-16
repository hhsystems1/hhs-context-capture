import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { publishAuditStatus, readAuditStatus, auditStatusFromSession } from './reconstruction-audit-status.mjs';

describe('operation-scoped audit visibility', () => {
  it('publishes only bounded status/counts and rejects scope swaps', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-status-'));
    try {
      const operation = 'operation_' + 'a'.repeat(32);
      const status = auditStatusFromSession('workspace_a', operation, { status: 'paused_by_operator' }, {
        operation_id: operation, next_batch_allowed: true,
        sources: [{ all_findings_persisted_match: 19, flags: [{ severity: 'advisory', note: 'private source text' }] }],
        semantic: { verdict: 'pass', sample_count: 19, issues: [] }
      });
      publishAuditStatus(root, { ...status, secret: 'private credential' });
      expect(readAuditStatus(root, 'workspace_a', operation)).toMatchObject({ phase: 'passed', continuation: 'paused', checked_findings: 19, sampled_findings: 19, advisory_issues: 1 });
      expect(JSON.stringify(readAuditStatus(root, 'workspace_a', operation))).not.toMatch(/private/);
      expect(() => readAuditStatus(root, 'workspace_b', operation)).toThrow();
      expect(() => readAuditStatus(root, 'workspace_a', '../outside')).toThrow();
      expect(() => publishAuditStatus(root, { ...status, checked_findings: -1 })).toThrow();
      expect(readAuditStatus(root, 'workspace_a', 'operation_' + 'b'.repeat(32))).toBeUndefined();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('never advertises automatic continuation for an explicitly single-batch session', () => {
    const operation = 'operation_' + 'a'.repeat(32);
    for (const status of ['waiting_for_batch', 'auditing', 'launching_next_batch']) {
      expect(auditStatusFromSession('workspace_a', operation, { status, single_batch: true }).continuation).toBe('paused');
    }
  });
  it('keeps active, blocked and failed review distinct from approval', () => {
    const operation = 'operation_' + 'a'.repeat(32);
    expect(auditStatusFromSession('workspace_a', operation, { status: 'auditing', current_stage: 'coherence_review' }).phase).toBe('coherence');
    expect(auditStatusFromSession('workspace_a', operation, { status: 'paused_for_audit' }).phase).toBe('failed');
    const blocked = auditStatusFromSession('workspace_a', operation, {}, { operation_id: operation, sources: [], semantic: { verdict: 'review_required', issues: [{ severity: 'blocking' }] } });
    expect(blocked).toMatchObject({ phase: 'review_required', blocking_issues: 1, continuation: 'paused' });
    expect(() => auditStatusFromSession('workspace_a', operation, {}, { operation_id: 'other' })).toThrow();
    expect(auditStatusFromSession('workspace_a', operation, {}, { operation_id: operation, sources: [], semantic: null }).phase).toBe('no_saved_findings');
  });
});
