-- Source Versions V1: generic evidence-source abstraction.
--
-- Additive only. memory_v1.capture_versions remains the browser-capture
-- specialization and is NOT rewritten: every existing row, constraint, trigger,
-- policy, and grant is left exactly as it is. Native OpenAI exports become a
-- first-class evidence family alongside browser captures, and both families
-- converge on the existing normalized conversations/messages/content_blocks/
-- provenance_edges tables rather than duplicating them.
--
-- Why source_version_id is NULLABLE on the normalized tables rather than
-- backfilled NOT NULL: existing rows are protected by the immutable_row_guard
-- BEFORE UPDATE triggers, so a backfill UPDATE is impossible by construction.
-- The exactly-one-of CHECK below therefore carries the integrity that a NOT NULL
-- column would otherwise carry, without touching a single historical row.

create table if not exists memory_v1.source_versions (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  source_version_id text not null,
  pipeline_version memory_v1.pipeline_version not null,
  source_record_id text not null,
  conversation_id text not null,

  -- Evidence family discriminator. Deliberately NOT a CHECK constraint: new
  -- source families must not require a migration. Known values today are
  -- 'native_export' and 'browser_capture'.
  source_family text not null,

  -- Hash of THIS conversation's canonical source content. Must be distinct per
  -- conversation. Never the shared container/file hash: memory_v1
  -- .capture_ingestion_completion_errors() resolves a run to a version by hash
  -- with `limit 1`, so a hash shared across conversations would silently bind
  -- every run to one arbitrary conversation.
  content_sha256 memory_v1.sha256 not null,

  immutable_source_locator text not null,

  -- Immutable export ZIP hash. Shared across every conversation in one export.
  -- The extracted conversations.json hash is separate file-level evidence.
  -- NULL for browser captures, which have no container.
  source_container_sha256 memory_v1.sha256,

  verification_status text not null
    check (verification_status in ('complete','partial','failed','needs_review')),

  -- Export generated_at OR capture completed_at. Named for what it means in
  -- both families rather than borrowing 'captured_at'.
  source_observed_at timestamptz not null,

  -- Family-specific fidelity metadata: adapter_version, branch indicators and
  -- truncation indicators for captures; container identity, content-type census
  -- and full-tree flag for exports.
  source_metadata jsonb not null default '{}'::jsonb,

  -- Set only when source_family='browser_capture'. Links a source version to the
  -- pre-existing capture row without modifying that row.
  capture_version_id text,

  idempotency_key memory_v1.sha256 not null,
  record_sha256 memory_v1.sha256 not null,
  created_at timestamptz not null,

  primary key (workspace_id, source_version_id, pipeline_version),
  unique (workspace_id, idempotency_key),
  unique (workspace_id, source_version_id),
  foreign key (workspace_id, source_record_id)
    references memory_v1.source_records(workspace_id, source_record_id),
  foreign key (workspace_id, capture_version_id)
    references memory_v1.capture_versions(workspace_id, capture_version_id)
    deferrable initially deferred,
  check (source_family <> 'browser_capture' or capture_version_id is not null),
  check (source_family <> 'native_export' or source_container_sha256 is not null)
);

alter table memory_v1.source_versions enable row level security;
alter table memory_v1.source_versions force row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='memory_v1' and tablename='source_versions'
      and policyname='workspace_isolation'
  ) then
    create policy workspace_isolation on memory_v1.source_versions
      using (workspace_id=current_setting('memory_v1.workspace_id',true))
      with check (workspace_id=current_setting('memory_v1.workspace_id',true));
  end if;
end $$;

drop trigger if exists immutable_row_guard on memory_v1.source_versions;
create trigger immutable_row_guard before update or delete on memory_v1.source_versions
  for each row execute function memory_v1.guard_immutable_row();

create index if not exists source_versions_conversation_idx
  on memory_v1.source_versions(workspace_id, conversation_id, pipeline_version);
create index if not exists source_versions_family_idx
  on memory_v1.source_versions(workspace_id, source_family);
create index if not exists source_versions_container_idx
  on memory_v1.source_versions(workspace_id, source_container_sha256);

-- Optional back-link from an existing capture to its source version. Nullable,
-- never backfilled (see header note on immutable_row_guard).
alter table memory_v1.capture_versions
  add column if not exists source_version_id text;

-- Evidence-bearing normalized tables accept exactly one evidence family.
do $$
declare target text;
begin
  foreach target in array array[
    'messages','content_blocks','provenance_edges',
    'verification_results','archive_hash_resolutions','message_range_chunks'
  ] loop
    execute format('alter table memory_v1.%I add column if not exists source_version_id text', target);
    execute format('alter table memory_v1.%I alter column capture_version_id drop not null', target);
    execute format(
      'alter table memory_v1.%I add constraint %I check (num_nonnulls(capture_version_id, source_version_id) = 1)',
      target, target || '_single_evidence_version_chk');
    execute format(
      'alter table memory_v1.%I add constraint %I foreign key (workspace_id, source_version_id) references memory_v1.source_versions(workspace_id, source_version_id) deferrable initially deferred',
      target, target || '_source_version_fk');
  end loop;
end $$;

-- conversations is deliberately EXCLUDED from the exactly-one-of rule above.
--
-- A conversation is the LOGICAL identity (source_conversation_id) and may be
-- witnessed by several source versions -- a Jan 6 export and a later export of
-- the same conversation are two source versions of one conversation. Pinning it
-- to a single evidence version is precisely what blocks the revision model.
-- Version linkage lives on memory_v1.source_versions.conversation_id and on the
-- per-version messages/content_blocks; the conversation row carries neither.
alter table memory_v1.conversations add column if not exists source_version_id text;
alter table memory_v1.conversations alter column capture_version_id drop not null;
alter table memory_v1.conversations add constraint conversations_source_version_fk
  foreign key (workspace_id, source_version_id)
  references memory_v1.source_versions(workspace_id, source_version_id) deferrable initially deferred;

-- Message sequence uniqueness for the native-export family mirrors the existing
-- per-capture unique constraint, which NULL capture_version_id cannot enforce.
create unique index if not exists messages_source_version_sequence_key
  on memory_v1.messages(workspace_id, source_version_id, sequence)
  where source_version_id is not null;

-- Register the proof kinds for this slice, following the additive
-- drop/recreate pattern established in 20260809000000_memory_v11_review_role.sql.
alter table memory_v1.proof_receipts drop constraint proof_receipts_proof_kind_check;
alter table memory_v1.proof_receipts add constraint proof_receipts_proof_kind_check check (proof_kind in (
  'clean_first_ingestion','idempotent_replay','interrupted_resume','workspace_isolation',
  'invalid_evidence_quarantine','failure_cannot_complete','changed_pipeline_coexistence',
  'database_immutability','exact_provenance_resolution','completed_insert_rejection',
  'fatal_quarantine_terminal','retry_lineage','legacy_provenance_repair',
  'review_approval_query',
  'native_export_provenance_resolution','mixed_source_family_coexistence'
));

revoke all on memory_v1.source_versions from public;
grant select on memory_v1.source_versions to memory_v1_ingest_writer, memory_v1_report_reader;
grant insert on memory_v1.source_versions to memory_v1_ingest_writer;

-- A source version must witness a real logical conversation. This FK is
-- deferred because native-export ingestion inserts an immutable source version
-- and its version-independent conversation in one transaction.
alter table memory_v1.source_versions
  add constraint source_versions_conversation_fk
  foreign key (workspace_id, conversation_id)
  references memory_v1.conversations(workspace_id, conversation_id)
  deferrable initially deferred;

-- The original provenance table assumed every edge targeted synthesized
-- knowledge. Source-version adapters also emit direct source-evidence edges,
-- whose target is the cited content block. Preserve the old candidate rule via
-- a guard while permitting that second, non-synthesis target honestly.
alter table memory_v1.provenance_edges
  drop constraint provenance_edges_target_record_type_check,
  drop constraint provenance_edges_workspace_id_target_record_id_fkey,
  drop constraint provenance_edges_candidate_pipeline_fk;
alter table memory_v1.provenance_edges
  add constraint provenance_edges_target_record_type_check
    check (target_record_type in ('knowledge_candidate','source_evidence')),
  add constraint provenance_edges_source_evidence_target_check
    check (target_record_type <> 'source_evidence' or target_record_id = content_block_id);

create or replace function memory_v1.guard_provenance_target()
returns trigger language plpgsql as $$
begin
  if new.target_record_type = 'knowledge_candidate' and not exists (
    select 1 from memory_v1.knowledge_candidates k
    where (k.workspace_id,k.knowledge_candidate_id,k.pipeline_version) =
          (new.workspace_id,new.target_record_id,new.pipeline_version)
  ) then
    raise exception using errcode='23503',
      message='provenance edge knowledge_candidate target does not exist';
  end if;
  return new;
end $$;

drop trigger if exists provenance_target_guard on memory_v1.provenance_edges;
create trigger provenance_target_guard
  before insert on memory_v1.provenance_edges
  for each row execute function memory_v1.guard_provenance_target();
