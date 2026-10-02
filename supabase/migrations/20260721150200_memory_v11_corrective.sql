create domain memory_v1.pipeline_version as text
  check (value ~ '^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$');

alter table memory_v1.ingestion_runs
  add column pipeline_version memory_v1.pipeline_version not null default 'memory-v1/legacy',
  add column expected_message_count integer check (expected_message_count >= 0),
  add column expected_content_block_count integer check (expected_content_block_count >= 0),
  add column expected_chunk_count integer check (expected_chunk_count >= 0),
  add column fatal_error_count integer not null default 0 check (fatal_error_count >= 0),
  add column completion_validated_at timestamptz,
  add constraint ingestion_runs_pipeline_identity unique (workspace_id, ingestion_run_id, pipeline_version);
alter table memory_v1.ingestion_runs alter column pipeline_version drop default;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'ingestion_checkpoints','message_range_chunks','archive_hash_resolutions','knowledge_candidates',
    'provenance_edges','candidate_evidence','human_review_events','approved_knowledge','entities',
    'relationships','contradictions','supersessions','use_cases','decisions','tasks','sops',
    'quarantine_items','dead_letters'
  ] loop
    execute format(
      'alter table memory_v1.%I add column pipeline_version memory_v1.pipeline_version not null default %L',
      table_name, 'memory-v1/legacy'
    );
    execute format('alter table memory_v1.%I alter column pipeline_version drop default', table_name);
  end loop;
end $$;

alter table memory_v1.archive_hash_resolutions add column ingestion_run_id text;
alter table memory_v1.quarantine_items add column fatal boolean not null default false;
alter table memory_v1.dead_letters add column fatal boolean not null default true;

alter table memory_v1.ingestion_checkpoints
  add constraint ingestion_checkpoints_pipeline_identity unique (workspace_id, checkpoint_id, pipeline_version),
  add constraint ingestion_checkpoints_run_pipeline_fk foreign key (workspace_id, ingestion_run_id, pipeline_version)
    references memory_v1.ingestion_runs(workspace_id, ingestion_run_id, pipeline_version);
alter table memory_v1.message_range_chunks
  add constraint message_range_chunks_pipeline_identity unique (workspace_id, chunk_id, pipeline_version),
  add constraint message_range_chunks_run_pipeline_fk foreign key (workspace_id, ingestion_run_id, pipeline_version)
    references memory_v1.ingestion_runs(workspace_id, ingestion_run_id, pipeline_version);
alter table memory_v1.archive_hash_resolutions
  add constraint archive_hash_resolutions_pipeline_identity unique (workspace_id, resolution_id, pipeline_version),
  add constraint archive_hash_resolutions_run_pipeline_fk foreign key (workspace_id, ingestion_run_id, pipeline_version)
    references memory_v1.ingestion_runs(workspace_id, ingestion_run_id, pipeline_version);
alter table memory_v1.knowledge_candidates
  add constraint knowledge_candidates_pipeline_identity unique (workspace_id, knowledge_candidate_id, pipeline_version),
  add constraint knowledge_candidates_chunk_pipeline_fk foreign key (workspace_id, chunk_id, pipeline_version)
    references memory_v1.message_range_chunks(workspace_id, chunk_id, pipeline_version);
alter table memory_v1.provenance_edges
  add constraint provenance_edges_pipeline_identity unique (workspace_id, provenance_edge_id, pipeline_version),
  add constraint provenance_edges_candidate_pipeline_fk foreign key (workspace_id, target_record_id, pipeline_version)
    references memory_v1.knowledge_candidates(workspace_id, knowledge_candidate_id, pipeline_version);
alter table memory_v1.candidate_evidence
  add constraint candidate_evidence_pipeline_identity unique (workspace_id, candidate_evidence_id, pipeline_version),
  add constraint candidate_evidence_candidate_pipeline_fk foreign key (workspace_id, knowledge_candidate_id, pipeline_version)
    references memory_v1.knowledge_candidates(workspace_id, knowledge_candidate_id, pipeline_version),
  add constraint candidate_evidence_edge_pipeline_fk foreign key (workspace_id, provenance_edge_id, pipeline_version)
    references memory_v1.provenance_edges(workspace_id, provenance_edge_id, pipeline_version);
alter table memory_v1.human_review_events
  add constraint human_review_events_pipeline_identity unique (workspace_id, human_review_event_id, pipeline_version),
  add constraint human_review_events_candidate_pipeline_fk foreign key (workspace_id, knowledge_candidate_id, pipeline_version)
    references memory_v1.knowledge_candidates(workspace_id, knowledge_candidate_id, pipeline_version);
alter table memory_v1.approved_knowledge
  add constraint approved_knowledge_pipeline_identity unique (workspace_id, approved_knowledge_id, pipeline_version),
  add constraint approved_knowledge_candidate_pipeline_fk foreign key (workspace_id, knowledge_candidate_id, pipeline_version)
    references memory_v1.knowledge_candidates(workspace_id, knowledge_candidate_id, pipeline_version),
  add constraint approved_knowledge_event_pipeline_fk foreign key (workspace_id, approval_event_id, pipeline_version)
    references memory_v1.human_review_events(workspace_id, human_review_event_id, pipeline_version);

do $$
declare spec text[];
begin
  foreach spec slice 1 in array array[
    array['entities','entity_id'], array['relationships','relationship_id'], array['contradictions','contradiction_id'],
    array['supersessions','supersession_id'], array['use_cases','use_case_id'], array['decisions','decision_id'],
    array['tasks','task_id'], array['sops','sop_id'], array['quarantine_items','quarantine_item_id'],
    array['dead_letters','dead_letter_id']
  ] loop
    execute format('alter table memory_v1.%I add constraint %I unique (workspace_id, %I, pipeline_version)',
      spec[1], spec[1] || '_pipeline_identity', spec[2]);
  end loop;
end $$;

alter table memory_v1.entities add constraint entities_approved_pipeline_fk
  foreign key (workspace_id, approved_knowledge_id, pipeline_version)
  references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id, pipeline_version);
alter table memory_v1.relationships add constraint relationships_approved_pipeline_fk
  foreign key (workspace_id, approved_knowledge_id, pipeline_version)
  references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id, pipeline_version);
alter table memory_v1.contradictions
  add constraint contradictions_left_pipeline_fk foreign key (workspace_id, left_record_id, pipeline_version)
    references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id, pipeline_version),
  add constraint contradictions_right_pipeline_fk foreign key (workspace_id, right_record_id, pipeline_version)
    references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id, pipeline_version);
alter table memory_v1.supersessions
  add constraint supersessions_prior_pipeline_fk foreign key (workspace_id, prior_approved_knowledge_id, pipeline_version)
    references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id, pipeline_version),
  add constraint supersessions_successor_pipeline_fk foreign key (workspace_id, successor_approved_knowledge_id, pipeline_version)
    references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id, pipeline_version),
  add constraint supersessions_event_pipeline_fk foreign key (workspace_id, human_review_event_id, pipeline_version)
    references memory_v1.human_review_events(workspace_id, human_review_event_id, pipeline_version);
do $$
declare table_name text;
begin
  foreach table_name in array array['use_cases','decisions','tasks','sops'] loop
    execute format(
      'alter table memory_v1.%I add constraint %I foreign key (workspace_id, approved_knowledge_id, pipeline_version) references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id, pipeline_version)',
      table_name, table_name || '_approved_pipeline_fk'
    );
  end loop;
end $$;
alter table memory_v1.quarantine_items add constraint quarantine_items_run_pipeline_fk
  foreign key (workspace_id, ingestion_run_id, pipeline_version)
  references memory_v1.ingestion_runs(workspace_id, ingestion_run_id, pipeline_version);
alter table memory_v1.dead_letters add constraint dead_letters_run_pipeline_fk
  foreign key (workspace_id, ingestion_run_id, pipeline_version)
  references memory_v1.ingestion_runs(workspace_id, ingestion_run_id, pipeline_version);

create table memory_v1.proof_receipts (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  proof_receipt_id text not null,
  ingestion_run_id text not null,
  pipeline_version memory_v1.pipeline_version not null,
  proof_kind text not null check (proof_kind in (
    'clean_first_ingestion','idempotent_replay','interrupted_resume','workspace_isolation',
    'invalid_evidence_quarantine','failure_cannot_complete','changed_pipeline_coexistence',
    'database_immutability','exact_provenance_resolution'
  )),
  schema_version text not null,
  receipt_locator text not null,
  receipt_sha256 memory_v1.sha256 not null,
  archive_tree_sha256 memory_v1.sha256 not null,
  idempotency_key memory_v1.sha256 not null,
  record_sha256 memory_v1.sha256 not null,
  created_at timestamptz not null,
  primary key (workspace_id, proof_receipt_id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, ingestion_run_id, pipeline_version)
    references memory_v1.ingestion_runs(workspace_id, ingestion_run_id, pipeline_version)
);

create or replace function memory_v1.ingestion_completion_errors(
  requested_workspace_id text,
  requested_ingestion_run_id text,
  requested_pipeline_version memory_v1.pipeline_version
) returns text[]
language plpgsql stable security definer
set search_path = memory_v1, pg_catalog
as $$
declare
  run_row memory_v1.ingestion_runs%rowtype;
  capture_id text;
  errors text[] := array[]::text[];
  actual integer;
begin
  select * into run_row from memory_v1.ingestion_runs
    where workspace_id=requested_workspace_id
      and ingestion_run_id=requested_ingestion_run_id
      and pipeline_version=requested_pipeline_version;
  if not found then return array['run_missing']; end if;
  if run_row.expected_message_count is null then errors := array_append(errors,'expected_message_count_missing'); end if;
  if run_row.expected_content_block_count is null then errors := array_append(errors,'expected_content_block_count_missing'); end if;
  if run_row.expected_chunk_count is null then errors := array_append(errors,'expected_chunk_count_missing'); end if;
  if run_row.fatal_error_count <> 0 then errors := array_append(errors,'fatal_error_count_nonzero'); end if;

  select capture_version_id into capture_id from memory_v1.capture_versions
    where workspace_id=requested_workspace_id and manifest_sha256=run_row.input_manifest_sha256
    order by capture_version_id limit 1;
  if capture_id is null then errors := array_append(errors,'capture_missing'); return errors; end if;

  select count(*) into actual from memory_v1.messages
    where workspace_id=requested_workspace_id and capture_version_id=capture_id;
  if run_row.expected_message_count is distinct from actual then errors := array_append(errors,'message_count_mismatch'); end if;
  select count(*) into actual from memory_v1.content_blocks
    where workspace_id=requested_workspace_id and capture_version_id=capture_id;
  if run_row.expected_content_block_count is distinct from actual then errors := array_append(errors,'content_block_count_mismatch'); end if;

  select count(*) into actual from memory_v1.ingestion_checkpoints
    where workspace_id=requested_workspace_id and ingestion_run_id=requested_ingestion_run_id
      and pipeline_version=requested_pipeline_version and checkpoint_key='message_ranges'
      and completed_chunk_count=run_row.expected_chunk_count
      and next_message_sequence=run_row.expected_message_count;
  if actual <> 1 then errors := array_append(errors,'checkpoint_incomplete'); end if;

  select count(*) into actual from memory_v1.message_range_chunks
    where workspace_id=requested_workspace_id and ingestion_run_id=requested_ingestion_run_id
      and pipeline_version=requested_pipeline_version;
  if run_row.expected_chunk_count is distinct from actual then errors := array_append(errors,'chunk_count_mismatch'); end if;
  if exists (
    with ordered as (
      select start_sequence,end_sequence,
        lag(end_sequence) over(order by start_sequence) as prior_end
      from memory_v1.message_range_chunks
      where workspace_id=requested_workspace_id and ingestion_run_id=requested_ingestion_run_id
        and pipeline_version=requested_pipeline_version
    )
    select 1 from ordered
      where (prior_end is null and start_sequence <> 0)
         or (prior_end is not null and start_sequence <> prior_end + 1)
  ) or coalesce((
    select max(end_sequence) from memory_v1.message_range_chunks
    where workspace_id=requested_workspace_id and ingestion_run_id=requested_ingestion_run_id
      and pipeline_version=requested_pipeline_version
  ),-1) <> coalesce(run_row.expected_message_count,0)-1 then
    errors := array_append(errors,'chunk_coverage_invalid');
  end if;

  select count(*) into actual
  from memory_v1.knowledge_candidates k
  join memory_v1.message_range_chunks ch
    on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
  where ch.workspace_id=requested_workspace_id and ch.ingestion_run_id=requested_ingestion_run_id
    and ch.pipeline_version=requested_pipeline_version and k.status='proposed';
  if run_row.expected_chunk_count is distinct from actual then errors := array_append(errors,'candidate_count_or_status_invalid'); end if;

  select count(*) into actual
  from memory_v1.provenance_edges p
  join memory_v1.knowledge_candidates k
    on (k.workspace_id,k.knowledge_candidate_id,k.pipeline_version)=(p.workspace_id,p.target_record_id,p.pipeline_version)
  join memory_v1.message_range_chunks ch
    on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
  join memory_v1.content_blocks b
    on (b.workspace_id,b.content_block_id)=(p.workspace_id,p.content_block_id)
  join memory_v1.archive_hash_resolutions a
    on a.workspace_id=b.workspace_id and a.source_record_id=b.source_record_id
      and a.capture_version_id=b.capture_version_id and a.pipeline_version=p.pipeline_version
      and a.expected_sha256=p.representation_sha256 and a.exact_match
  where ch.workspace_id=requested_workspace_id and ch.ingestion_run_id=requested_ingestion_run_id
    and ch.pipeline_version=requested_pipeline_version
    and b.representations @> jsonb_build_array(jsonb_build_object(
      'representation_kind',p.representation_kind,'sha256',p.representation_sha256));
  if run_row.expected_content_block_count is distinct from actual then errors := array_append(errors,'provenance_resolution_invalid'); end if;

  select count(*) into actual from memory_v1.archive_hash_resolutions
    where workspace_id=requested_workspace_id and ingestion_run_id=requested_ingestion_run_id
      and pipeline_version=requested_pipeline_version and capture_version_id=capture_id and exact_match;
  if (1 + coalesce(run_row.expected_message_count,0) + coalesce(run_row.expected_content_block_count,0)) <> actual then
    errors := array_append(errors,'source_hash_resolution_invalid');
  end if;
  if exists (select 1 from memory_v1.quarantine_items
    where workspace_id=requested_workspace_id and ingestion_run_id=requested_ingestion_run_id
      and pipeline_version=requested_pipeline_version and fatal and status='open') then
    errors := array_append(errors,'fatal_quarantine_open');
  end if;
  if exists (select 1 from memory_v1.dead_letters
    where workspace_id=requested_workspace_id and ingestion_run_id=requested_ingestion_run_id
      and pipeline_version=requested_pipeline_version and fatal) then
    errors := array_append(errors,'fatal_dead_letter_present');
  end if;
  if not exists (select 1 from memory_v1.verification_results
    where workspace_id=requested_workspace_id and capture_version_id=capture_id and status='complete') then
    errors := array_append(errors,'capture_verification_incomplete');
  end if;
  return errors;
end $$;

create or replace function memory_v1.guard_ingestion_run_transition() returns trigger
language plpgsql
set search_path = memory_v1, pg_catalog
as $$
declare errors text[];
begin
  if tg_op='DELETE' then raise exception using errcode='55000', message='ingestion runs cannot be deleted'; end if;
  if new.workspace_id<>old.workspace_id or new.ingestion_run_id<>old.ingestion_run_id
    or new.source_system_id<>old.source_system_id or new.source_account_id<>old.source_account_id
    or new.idempotency_key<>old.idempotency_key or new.input_manifest_sha256<>old.input_manifest_sha256
    or new.pipeline_version<>old.pipeline_version or new.started_at<>old.started_at
    or new.expected_message_count is distinct from old.expected_message_count
    or new.expected_content_block_count is distinct from old.expected_content_block_count
    or new.expected_chunk_count is distinct from old.expected_chunk_count then
    raise exception using errcode='55000', message='immutable ingestion run identity or expectations cannot change';
  end if;
  if old.status='completed' then raise exception using errcode='55000', message='completed ingestion runs are immutable'; end if;
  if new.attempt_count < old.attempt_count or new.fatal_error_count < old.fatal_error_count then
    raise exception using errcode='23514', message='ingestion counters cannot decrease';
  end if;
  if old.status<>new.status and not (
    (old.status='pending' and new.status in ('running','failed','quarantined')) or
    (old.status='running' and new.status in ('partial','failed','quarantined','completed')) or
    (old.status='partial' and new.status in ('running','failed','quarantined')) or
    (old.status='failed' and new.status='running') or
    (old.status='quarantined' and new.status='running')
  ) then raise exception using errcode='23514', message='invalid ingestion status transition'; end if;
  if new.status='completed' then
    if new.completed_at is null or new.completion_validated_at is null or new.checkpoint_key<>'complete' then
      raise exception using errcode='23514', message='completion metadata is incomplete';
    end if;
    errors := memory_v1.ingestion_completion_errors(new.workspace_id,new.ingestion_run_id,new.pipeline_version);
    if cardinality(errors)>0 then
      raise exception using errcode='23514', message='ingestion completion invariants failed: ' || array_to_string(errors,',');
    end if;
  elsif new.completed_at is not null or new.completion_validated_at is not null then
    raise exception using errcode='23514', message='non-completed ingestion run cannot carry completion timestamps';
  end if;
  return new;
end $$;
create trigger ingestion_run_transition_guard before update or delete on memory_v1.ingestion_runs
  for each row execute function memory_v1.guard_ingestion_run_transition();

create or replace function memory_v1.guard_checkpoint_transition() returns trigger
language plpgsql
set search_path = memory_v1, pg_catalog
as $$
begin
  if tg_op='DELETE' then raise exception using errcode='55000', message='ingestion checkpoints cannot be deleted'; end if;
  if new.workspace_id<>old.workspace_id or new.checkpoint_id<>old.checkpoint_id
    or new.ingestion_run_id<>old.ingestion_run_id or new.checkpoint_key<>old.checkpoint_key
    or new.pipeline_version<>old.pipeline_version then
    raise exception using errcode='55000', message='checkpoint identity cannot change';
  end if;
  if new.next_message_sequence<old.next_message_sequence or new.completed_chunk_count<old.completed_chunk_count then
    raise exception using errcode='23514', message='checkpoint progress cannot move backward';
  end if;
  return new;
end $$;
create trigger checkpoint_transition_guard before update or delete on memory_v1.ingestion_checkpoints
  for each row execute function memory_v1.guard_checkpoint_transition();

do $$ begin
  if not exists(select 1 from pg_roles where rolname='memory_v1_maintenance') then create role memory_v1_maintenance nologin; end if;
  if not exists(select 1 from pg_roles where rolname='memory_v1_ingest_writer') then create role memory_v1_ingest_writer nologin; end if;
  if not exists(select 1 from pg_roles where rolname='memory_v1_report_reader') then create role memory_v1_report_reader nologin; end if;
  if not exists(select 1 from pg_roles where rolname='memory_v1_ingest_login') then create role memory_v1_ingest_login login inherit; end if;
  if not exists(select 1 from pg_roles where rolname='memory_v1_report_login') then create role memory_v1_report_login login inherit; end if;
end $$;
grant memory_v1_ingest_writer to memory_v1_ingest_login;
grant memory_v1_report_reader to memory_v1_report_login;
grant memory_v1_maintenance to postgres;

create or replace function memory_v1.guard_immutable_row() returns trigger
language plpgsql
set search_path = memory_v1, pg_catalog
as $$
begin
  if pg_has_role(current_user,'memory_v1_maintenance','member')
    and current_setting('memory_v1.maintenance_mode',true)='on' then
    return case when tg_op='DELETE' then old else new end;
  end if;
  raise exception using errcode='55000', message=format('%s.%s is append-only',tg_table_schema,tg_table_name);
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'source_systems','source_accounts','source_records','capture_versions','conversations','messages','content_blocks',
    'verification_results','message_range_chunks','archive_hash_resolutions','knowledge_candidates','provenance_edges',
    'candidate_evidence','human_review_events','approved_knowledge','entities','relationships','contradictions',
    'supersessions','use_cases','decisions','tasks','sops','proof_receipts'
  ] loop
    execute format('create trigger immutable_row_guard before update or delete on memory_v1.%I for each row execute function memory_v1.guard_immutable_row()',table_name);
  end loop;
end $$;

create or replace function memory_v1.guard_fatal_after_completion() returns trigger
language plpgsql
set search_path = memory_v1, pg_catalog
as $$
begin
  if new.fatal and exists(select 1 from memory_v1.ingestion_runs
    where workspace_id=new.workspace_id and ingestion_run_id=new.ingestion_run_id
      and pipeline_version=new.pipeline_version and status='completed') then
    raise exception using errcode='23514', message='fatal operational evidence cannot be attached to a completed run';
  end if;
  return new;
end $$;
create trigger quarantine_fatal_completion_guard before insert or update on memory_v1.quarantine_items
  for each row execute function memory_v1.guard_fatal_after_completion();
create trigger dead_letter_fatal_completion_guard before insert or update on memory_v1.dead_letters
  for each row execute function memory_v1.guard_fatal_after_completion();

alter table memory_v1.proof_receipts enable row level security;
create policy workspace_isolation on memory_v1.proof_receipts
  using (workspace_id=current_setting('memory_v1.workspace_id',true))
  with check (workspace_id=current_setting('memory_v1.workspace_id',true));
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'workspaces','source_systems','source_accounts','ingestion_runs','source_records','capture_versions',
    'conversations','messages','content_blocks','verification_results','ingestion_checkpoints','message_range_chunks',
    'archive_hash_resolutions','knowledge_candidates','provenance_edges','candidate_evidence','human_review_events',
    'approved_knowledge','entities','relationships','contradictions','supersessions','use_cases','decisions','tasks',
    'sops','quarantine_items','dead_letters','proof_receipts'
  ] loop
    execute format('alter table memory_v1.%I force row level security',table_name);
    execute format('revoke all on memory_v1.%I from public',table_name);
    execute format('grant select on memory_v1.%I to memory_v1_ingest_writer,memory_v1_report_reader',table_name);
  end loop;
end $$;
grant usage on schema memory_v1 to memory_v1_ingest_writer,memory_v1_report_reader;
grant insert on memory_v1.workspaces,memory_v1.source_systems,memory_v1.source_accounts,
  memory_v1.ingestion_runs,memory_v1.source_records,memory_v1.capture_versions,memory_v1.conversations,
  memory_v1.messages,memory_v1.content_blocks,memory_v1.verification_results,memory_v1.ingestion_checkpoints,
  memory_v1.message_range_chunks,memory_v1.archive_hash_resolutions,memory_v1.knowledge_candidates,
  memory_v1.provenance_edges,memory_v1.candidate_evidence,memory_v1.quarantine_items,
  memory_v1.dead_letters,memory_v1.proof_receipts to memory_v1_ingest_writer;
grant update(status) on memory_v1.workspaces to memory_v1_ingest_writer;
grant update(status,completed_at,checkpoint_key,attempt_count,fatal_error_count,completion_validated_at)
  on memory_v1.ingestion_runs to memory_v1_ingest_writer;
grant update(next_message_sequence,completed_chunk_count,state_sha256,updated_at)
  on memory_v1.ingestion_checkpoints to memory_v1_ingest_writer;
grant update(status) on memory_v1.quarantine_items to memory_v1_ingest_writer;
grant update(attempt_count,next_retry_at) on memory_v1.dead_letters to memory_v1_ingest_writer;
revoke all on function memory_v1.ingestion_completion_errors(text,text,memory_v1.pipeline_version) from public;
grant execute on function memory_v1.ingestion_completion_errors(text,text,memory_v1.pipeline_version)
  to memory_v1_ingest_writer,memory_v1_report_reader;

drop view memory_v1.import_report;
create view memory_v1.import_report with (security_invoker=true) as
select w.workspace_id, w.name as workspace_name, r.ingestion_run_id, r.pipeline_version,
       r.status as run_status, r.completion_validated_at,
       c.capture_version_id, c.verification_status, c.manifest_sha256,
       (select count(*) from memory_v1.messages m
         where m.workspace_id=w.workspace_id and m.capture_version_id=c.capture_version_id) as message_count,
       (select count(*) from memory_v1.content_blocks b
         where b.workspace_id=w.workspace_id and b.capture_version_id=c.capture_version_id) as content_block_count,
       (select count(*) from memory_v1.message_range_chunks ch
         where ch.workspace_id=w.workspace_id and ch.ingestion_run_id=r.ingestion_run_id
           and ch.pipeline_version=r.pipeline_version) as chunk_count,
       (select count(*) from memory_v1.knowledge_candidates k
         join memory_v1.message_range_chunks ch
           on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
         where k.workspace_id=w.workspace_id and ch.ingestion_run_id=r.ingestion_run_id
           and ch.pipeline_version=r.pipeline_version and k.status='proposed') as proposed_candidate_count,
       (select count(*) from memory_v1.provenance_edges p
         join memory_v1.knowledge_candidates k
           on (k.workspace_id,k.knowledge_candidate_id,k.pipeline_version)=(p.workspace_id,p.target_record_id,p.pipeline_version)
         join memory_v1.message_range_chunks ch
           on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
         where p.workspace_id=w.workspace_id and ch.ingestion_run_id=r.ingestion_run_id
           and ch.pipeline_version=r.pipeline_version) as provenance_edge_count,
       (select count(*) from memory_v1.archive_hash_resolutions a
         where a.workspace_id=w.workspace_id
           and (a.ingestion_run_id=r.ingestion_run_id or (a.ingestion_run_id is null and r.pipeline_version='memory-v1/legacy'))
           and a.pipeline_version=r.pipeline_version and a.capture_version_id=c.capture_version_id and a.exact_match) as exact_hash_resolution_count,
       (select count(*) from memory_v1.quarantine_items q
         where q.workspace_id=w.workspace_id and q.ingestion_run_id=r.ingestion_run_id
           and q.pipeline_version=r.pipeline_version) as quarantine_count,
       (select count(*) from memory_v1.approved_knowledge ak
         where ak.workspace_id=w.workspace_id and ak.pipeline_version=r.pipeline_version) as approved_knowledge_count
from memory_v1.workspaces w
join memory_v1.ingestion_runs r using (workspace_id)
join memory_v1.capture_versions c
  on c.workspace_id=r.workspace_id and c.manifest_sha256=r.input_manifest_sha256;
revoke all on memory_v1.import_report from public;
grant select on memory_v1.import_report to memory_v1_ingest_writer,memory_v1_report_reader;
