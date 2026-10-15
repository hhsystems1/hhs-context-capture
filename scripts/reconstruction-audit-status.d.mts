export interface AuditStatus {
  operation_id: string;
  phase: 'pending' | 'validating' | 'coherence' | 'passed' | 'review_required' | 'failed' | 'no_saved_findings';
  continuation: 'automatic' | 'paused';
  updated_at: string;
  checked_findings: number;
  sampled_findings: number;
  advisory_issues: number;
  blocking_issues: number;
}
export function publishAuditStatus(root: string, value: AuditStatus & { workspace: string }): AuditStatus;
export function readAuditStatus(root: string, workspace: string, operation: string): AuditStatus | undefined;
export function auditStatusFromSession(workspace: string, operation: string, state: { status: string; current_stage?: string; audit_only?: boolean }, audit?: unknown): AuditStatus & { workspace: string };
