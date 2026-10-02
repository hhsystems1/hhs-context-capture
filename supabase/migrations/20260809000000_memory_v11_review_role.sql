-- Memory V1.1 Phase 1: least-privilege human review role.
-- Additive only. Creates the reviewer group and login roles and grants INSERT on
-- exactly the two append-only review tables (human_review_events, approved_knowledge).
-- No existing role, grant, table, trigger, policy, or row is modified or removed.
-- Read access comes from membership in the existing memory_v1_report_reader role;
-- immutability remains enforced by the existing immutable_row_guard triggers and
-- forced row-level security remains in effect for all review writes.

do $$ begin
  if not exists(select 1 from pg_roles where rolname='memory_v1_reviewer') then create role memory_v1_reviewer nologin; end if;
  if not exists(select 1 from pg_roles where rolname='memory_v1_review_login') then create role memory_v1_review_login login inherit; end if;
end $$;

grant memory_v1_report_reader to memory_v1_reviewer;
grant memory_v1_reviewer to memory_v1_review_login;

grant insert on memory_v1.human_review_events, memory_v1.approved_knowledge to memory_v1_reviewer;

-- Register the review-slice proof kind, following the additive pattern of
-- 20260722233500_memory_v11_audit_corrections.sql.
alter table memory_v1.proof_receipts drop constraint proof_receipts_proof_kind_check;
alter table memory_v1.proof_receipts add constraint proof_receipts_proof_kind_check check (proof_kind in (
  'clean_first_ingestion','idempotent_replay','interrupted_resume','workspace_isolation',
  'invalid_evidence_quarantine','failure_cannot_complete','changed_pipeline_coexistence',
  'database_immutability','exact_provenance_resolution','completed_insert_rejection',
  'fatal_quarantine_terminal','retry_lineage','legacy_provenance_repair',
  'review_approval_query'
));
