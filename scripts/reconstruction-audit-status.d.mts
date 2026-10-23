export interface AuditStatus {
  operation_id: string;
  phase: 'pending' | 'validating' | 'coherence' | 'passed' | 'review_required' | 'reviewed' | 'failed' | 'no_saved_findings';
  continuation: 'automatic' | 'paused';
  updated_at: string;
  checked_findings: number;
  sampled_findings: number;
  advisory_issues: number;
  blocking_issues: number;
  review?: { revision: string; source_conversation_id: string; can_acknowledge: boolean;
    reasons: Array<{ code: string; summary: string }>; recorded_at?: string; rationale?: string };
}
export interface AuditReviewInput { operation_id: string; revision: string; reviewer_ref: string; rationale: string; acknowledge_limitations: true }
export interface AuditReviewReceipt { operation_id: string; revision: string; recorded_at: string; continuation: 'paused'; replay: boolean }
export function acknowledgeAuditReview(root: string, workspace: string, input: AuditReviewInput): AuditReviewReceipt;
export function publishAuditStatus(root: string, value: AuditStatus & { workspace: string }): AuditStatus;
export function readAuditStatus(root: string, workspace: string, operation: string): AuditStatus | undefined;
export function auditStatusFromSession(workspace: string, operation: string, state: { status: string; current_stage?: string; audit_only?: boolean }, audit?: unknown): AuditStatus & { workspace: string };
