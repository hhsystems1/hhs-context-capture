-- Knowledge Extraction V1: additive run metadata and completion invariants.
--
-- Capture-ingestion runs retain their original completion validator byte-for-
-- byte under memory_v1.capture_ingestion_completion_errors(). The public
-- ingestion_completion_errors() entry point dispatches to that original
-- validator unless a run has an immutable knowledge_extraction_runs row.

create table if not exists memory_v1.knowledge_extraction_runs (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  extraction_run_id text not null,
  pipeline_version memory_v1.pipeline_version not null,
  source_capture_version_id text not null,
  conversation_id text not null,
  extraction_input_sha256 memory_v1.sha256 not null,
  extraction_model text not null,
  extractor_version text not null,
  expected_candidate_count integer not null check (expected_candidate_count > 0),
  expected_evidence_count integer not null check (expected_evidence_count > 0),
  expected_evidence_range_count integer not null check (expected_evidence_range_count > 0),
  idempotency_key memory_v1.sha256 not null,
  record_sha256 memory_v1.sha256 not null,
  created_at timestamptz not null,
  primary key (workspace_id, extraction_run_id, pipeline_version),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, extraction_run_id, pipeline_version)
    references memory_v1.ingestion_runs(workspace_id, ingestion_run_id, pipeline_version),
  foreign key (workspace_id, source_capture_version_id)
    references memory_v1.capture_versions(workspace_id, capture_version_id),
  foreign key (workspace_id, conversation_id)
    references memory_v1.conversations(workspace_id, conversation_id)
);

alter table memory_v1.knowledge_extraction_runs enable row level security;
alter table memory_v1.knowledge_extraction_runs force row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='memory_v1' and tablename='knowledge_extraction_runs'
      and policyname='workspace_isolation'
  ) then
    create policy workspace_isolation on memory_v1.knowledge_extraction_runs
      using (workspace_id=current_setting('memory_v1.workspace_id',true))
      with check (workspace_id=current_setting('memory_v1.workspace_id',true));
  end if;
end $$;

create or replace function memory_v1.guard_knowledge_extraction_run_insert() returns trigger
language plpgsql
set search_path = memory_v1, pg_catalog
as $$
declare base_status text; base_manifest memory_v1.sha256; capture_manifest memory_v1.sha256;
begin
  select status,input_manifest_sha256 into base_status,base_manifest
  from memory_v1.ingestion_runs
  where workspace_id=new.workspace_id and ingestion_run_id=new.extraction_run_id
    and pipeline_version=new.pipeline_version;
  if base_status is null then
    raise exception using errcode='23503',message='knowledge extraction base run does not exist';
  end if;
  if base_status not in ('pending','running') then
    raise exception using errcode='23514',message='knowledge extraction metadata must be attached before run completion';
  end if;
  select manifest_sha256 into capture_manifest from memory_v1.capture_versions
  where workspace_id=new.workspace_id and capture_version_id=new.source_capture_version_id;
  if capture_manifest is null or capture_manifest<>base_manifest then
    raise exception using errcode='23514',message='knowledge extraction source capture does not match the base run manifest';
  end if;
  if not exists (
    select 1 from memory_v1.conversations c
    where c.workspace_id=new.workspace_id and c.conversation_id=new.conversation_id
      and c.capture_version_id=new.source_capture_version_id
  ) then
    raise exception using errcode='23514',message='knowledge extraction conversation does not belong to the source capture';
  end if;
  return new;
end $$;

drop trigger if exists knowledge_extraction_run_insert_guard on memory_v1.knowledge_extraction_runs;
create trigger knowledge_extraction_run_insert_guard before insert on memory_v1.knowledge_extraction_runs
  for each row execute function memory_v1.guard_knowledge_extraction_run_insert();

drop trigger if exists immutable_row_guard on memory_v1.knowledge_extraction_runs;
create trigger immutable_row_guard before update or delete on memory_v1.knowledge_extraction_runs
  for each row execute function memory_v1.guard_immutable_row();

-- Preserve the original capture-ingestion validator exactly by renaming it
-- once. Re-running this migration leaves the preserved function untouched.
do $$ begin
  if to_regprocedure('memory_v1.capture_ingestion_completion_errors(text,text,memory_v1.pipeline_version)') is null then
    alter function memory_v1.ingestion_completion_errors(text,text,memory_v1.pipeline_version)
      rename to capture_ingestion_completion_errors;
  end if;
end $$;

create or replace function memory_v1.knowledge_extraction_completion_errors(
  requested_workspace_id text,
  requested_ingestion_run_id text,
  requested_pipeline_version memory_v1.pipeline_version
) returns text[]
language plpgsql stable security definer
set search_path = memory_v1, pg_catalog
as $$
declare
  run_row memory_v1.ingestion_runs%rowtype;
  extraction_row memory_v1.knowledge_extraction_runs%rowtype;
  errors text[] := array[]::text[];
  actual integer;
  valid_count integer;
begin
  select * into run_row from memory_v1.ingestion_runs
  where workspace_id=requested_workspace_id
    and ingestion_run_id=requested_ingestion_run_id
    and pipeline_version=requested_pipeline_version;
  if not found then return array['run_missing']; end if;

  select * into extraction_row from memory_v1.knowledge_extraction_runs
  where workspace_id=requested_workspace_id
    and extraction_run_id=requested_ingestion_run_id
    and pipeline_version=requested_pipeline_version;
  if not found then return array['extraction_metadata_missing']; end if;

  if run_row.fatal_error_count<>0 then errors:=array_append(errors,'fatal_error_count_nonzero'); end if;
  if run_row.expected_message_count is null then errors:=array_append(errors,'expected_message_count_missing'); end if;
  if run_row.expected_content_block_count is distinct from extraction_row.expected_evidence_count then
    errors:=array_append(errors,'expected_evidence_count_mismatch');
  end if;
  if run_row.expected_chunk_count is distinct from extraction_row.expected_evidence_range_count then
    errors:=array_append(errors,'expected_evidence_range_count_mismatch');
  end if;
  if run_row.input_manifest_sha256 is distinct from (
    select manifest_sha256 from memory_v1.capture_versions
    where workspace_id=requested_workspace_id
      and capture_version_id=extraction_row.source_capture_version_id
  ) then errors:=array_append(errors,'source_capture_manifest_mismatch'); end if;
  if run_row.expected_message_count is distinct from (
    select count(*) from memory_v1.messages
    where workspace_id=requested_workspace_id
      and capture_version_id=extraction_row.source_capture_version_id
  ) then errors:=array_append(errors,'source_message_count_mismatch'); end if;
  if not exists (
    select 1 from memory_v1.verification_results
    where workspace_id=requested_workspace_id
      and capture_version_id=extraction_row.source_capture_version_id
      and status='complete'
  ) then errors:=array_append(errors,'capture_verification_incomplete'); end if;

  select count(*) into actual from memory_v1.message_range_chunks
  where workspace_id=requested_workspace_id
    and ingestion_run_id=requested_ingestion_run_id
    and pipeline_version=requested_pipeline_version
    and capture_version_id=extraction_row.source_capture_version_id;
  if actual<>extraction_row.expected_evidence_range_count then
    errors:=array_append(errors,'evidence_range_count_mismatch');
  end if;
  if exists (
    select 1 from memory_v1.message_range_chunks ch
    where ch.workspace_id=requested_workspace_id
      and ch.ingestion_run_id=requested_ingestion_run_id
      and ch.pipeline_version=requested_pipeline_version
      and (
        ch.capture_version_id<>extraction_row.source_capture_version_id
        or jsonb_array_length(ch.message_ids)=0
        or exists (
          select 1 from jsonb_array_elements_text(ch.message_ids) ids(message_id)
          where not exists (
            select 1 from memory_v1.messages m
            where m.workspace_id=ch.workspace_id and m.message_id=ids.message_id
              and m.capture_version_id=extraction_row.source_capture_version_id
              and m.sequence between ch.start_sequence and ch.end_sequence
          )
        )
      )
  ) then errors:=array_append(errors,'evidence_range_invalid'); end if;

  select count(*) into actual
  from memory_v1.knowledge_candidates k
  join memory_v1.message_range_chunks ch
    on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
  where ch.workspace_id=requested_workspace_id
    and ch.ingestion_run_id=requested_ingestion_run_id
    and ch.pipeline_version=requested_pipeline_version
    and k.status='proposed';
  if actual<>extraction_row.expected_candidate_count then
    errors:=array_append(errors,'candidate_count_or_status_invalid');
  end if;
  if exists (
    select 1 from memory_v1.knowledge_candidates k
    join memory_v1.message_range_chunks ch
      on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
    where ch.workspace_id=requested_workspace_id
      and ch.ingestion_run_id=requested_ingestion_run_id
      and ch.pipeline_version=requested_pipeline_version
      and not exists (
        select 1 from memory_v1.candidate_evidence ce
        where ce.workspace_id=k.workspace_id
          and ce.knowledge_candidate_id=k.knowledge_candidate_id
          and ce.pipeline_version=k.pipeline_version
      )
  ) then errors:=array_append(errors,'candidate_evidence_missing'); end if;

  select count(*) into actual
  from memory_v1.candidate_evidence ce
  join memory_v1.knowledge_candidates k
    on (k.workspace_id,k.knowledge_candidate_id,k.pipeline_version)=(ce.workspace_id,ce.knowledge_candidate_id,ce.pipeline_version)
  join memory_v1.message_range_chunks ch
    on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
  where ch.workspace_id=requested_workspace_id
    and ch.ingestion_run_id=requested_ingestion_run_id
    and ch.pipeline_version=requested_pipeline_version;
  if actual<>extraction_row.expected_evidence_count then
    errors:=array_append(errors,'candidate_evidence_count_mismatch');
  end if;

  select count(*) into valid_count
  from memory_v1.candidate_evidence ce
  join memory_v1.knowledge_candidates k
    on (k.workspace_id,k.knowledge_candidate_id,k.pipeline_version)=(ce.workspace_id,ce.knowledge_candidate_id,ce.pipeline_version)
  join memory_v1.message_range_chunks ch
    on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
  join memory_v1.provenance_edges p
    on (p.workspace_id,p.provenance_edge_id,p.pipeline_version)=(ce.workspace_id,ce.provenance_edge_id,ce.pipeline_version)
   and p.target_record_id=ce.knowledge_candidate_id
  join memory_v1.content_blocks b
    on (b.workspace_id,b.content_block_id)=(p.workspace_id,p.content_block_id)
   and b.source_record_id=p.source_record_id
   and b.message_id=p.message_id
   and b.capture_version_id=p.capture_version_id
  join memory_v1.messages m
    on (m.workspace_id,m.message_id)=(b.workspace_id,b.message_id)
   and m.conversation_id=p.conversation_id
   and m.capture_version_id=p.capture_version_id
  join memory_v1.archive_hash_resolutions a
    on a.workspace_id=p.workspace_id
   and a.ingestion_run_id=requested_ingestion_run_id
   and a.pipeline_version=p.pipeline_version
   and a.source_record_id=p.source_record_id
   and a.capture_version_id=p.capture_version_id
   and a.expected_sha256=p.representation_sha256
   and a.exact_match
  where ch.workspace_id=requested_workspace_id
    and ch.ingestion_run_id=requested_ingestion_run_id
    and ch.pipeline_version=requested_pipeline_version
    and p.capture_version_id=extraction_row.source_capture_version_id
    and p.conversation_id=extraction_row.conversation_id
    and b.representations @> jsonb_build_array(jsonb_build_object(
      'representation_kind',p.representation_kind,'sha256',p.representation_sha256));
  if valid_count<>extraction_row.expected_evidence_count then
    errors:=array_append(errors,'provenance_resolution_invalid');
  end if;
  if exists (
    select 1 from memory_v1.provenance_edges p
    join memory_v1.knowledge_candidates k
      on (k.workspace_id,k.knowledge_candidate_id,k.pipeline_version)=(p.workspace_id,p.target_record_id,p.pipeline_version)
    join memory_v1.message_range_chunks ch
      on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
    where ch.workspace_id=requested_workspace_id
      and ch.ingestion_run_id=requested_ingestion_run_id
      and ch.pipeline_version=requested_pipeline_version
      and not exists (
        select 1 from memory_v1.candidate_evidence ce
        where (ce.workspace_id,ce.provenance_edge_id,ce.pipeline_version)=(p.workspace_id,p.provenance_edge_id,p.pipeline_version)
          and ce.knowledge_candidate_id=p.target_record_id
      )
  ) then errors:=array_append(errors,'orphan_provenance_edge'); end if;
  if exists (
    select 1 from memory_v1.quarantine_items
    where workspace_id=requested_workspace_id and ingestion_run_id=requested_ingestion_run_id
      and pipeline_version=requested_pipeline_version and fatal and status='open'
  ) then errors:=array_append(errors,'fatal_quarantine_open'); end if;
  if exists (
    select 1 from memory_v1.dead_letters
    where workspace_id=requested_workspace_id and ingestion_run_id=requested_ingestion_run_id
      and pipeline_version=requested_pipeline_version and fatal
  ) then errors:=array_append(errors,'fatal_dead_letter_present'); end if;
  return errors;
end $$;

create or replace function memory_v1.ingestion_completion_errors(
  requested_workspace_id text,
  requested_ingestion_run_id text,
  requested_pipeline_version memory_v1.pipeline_version
) returns text[]
language plpgsql stable security definer
set search_path = memory_v1, pg_catalog
as $$
begin
  if exists (
    select 1 from memory_v1.knowledge_extraction_runs
    where workspace_id=requested_workspace_id
      and extraction_run_id=requested_ingestion_run_id
      and pipeline_version=requested_pipeline_version
  ) then
    return memory_v1.knowledge_extraction_completion_errors(
      requested_workspace_id,requested_ingestion_run_id,requested_pipeline_version);
  end if;
  return memory_v1.capture_ingestion_completion_errors(
    requested_workspace_id,requested_ingestion_run_id,requested_pipeline_version);
end $$;

create index if not exists knowledge_extraction_runs_capture_idx
  on memory_v1.knowledge_extraction_runs(workspace_id,source_capture_version_id,pipeline_version);

revoke all on memory_v1.knowledge_extraction_runs from public;
grant select on memory_v1.knowledge_extraction_runs to memory_v1_ingest_writer,memory_v1_report_reader;
grant insert on memory_v1.knowledge_extraction_runs to memory_v1_ingest_writer;

revoke all on function memory_v1.capture_ingestion_completion_errors(text,text,memory_v1.pipeline_version) from public;
revoke all on function memory_v1.knowledge_extraction_completion_errors(text,text,memory_v1.pipeline_version) from public;
revoke all on function memory_v1.ingestion_completion_errors(text,text,memory_v1.pipeline_version) from public;
grant execute on function memory_v1.capture_ingestion_completion_errors(text,text,memory_v1.pipeline_version)
  to memory_v1_ingest_writer,memory_v1_report_reader;
grant execute on function memory_v1.knowledge_extraction_completion_errors(text,text,memory_v1.pipeline_version)
  to memory_v1_ingest_writer,memory_v1_report_reader;
grant execute on function memory_v1.ingestion_completion_errors(text,text,memory_v1.pipeline_version)
  to memory_v1_ingest_writer,memory_v1_report_reader;
