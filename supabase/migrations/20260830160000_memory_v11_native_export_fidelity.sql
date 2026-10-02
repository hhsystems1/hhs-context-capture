-- Native export fidelity: retain source message timestamps where OpenAI
-- supplies them. Nullable because browser captures and some export nodes do not
-- carry source timestamps. Existing immutable rows are not backfilled.
alter table memory_v1.messages
  add column if not exists source_created_at timestamptz,
  add column if not exists source_updated_at timestamptz;

create or replace function memory_v1.native_export_completion_errors(
  requested_workspace_id text,
  requested_ingestion_run_id text,
  requested_pipeline_version memory_v1.pipeline_version
) returns text[]
language plpgsql stable security definer
set search_path = memory_v1, pg_catalog
as $$
declare run_row memory_v1.ingestion_runs%rowtype; errors text[]:=array[]::text[]; actual integer;
begin
  select * into run_row from memory_v1.ingestion_runs
  where workspace_id=requested_workspace_id and ingestion_run_id=requested_ingestion_run_id
    and pipeline_version=requested_pipeline_version;
  if not found then return array['run_missing']; end if;
  if run_row.input_manifest_sha256 <> '4cdfcdd3b55e4a391575ac41f08871bcc07c8742cc907a0d3603e25299aade12' then errors:=array_append(errors,'zip_hash_mismatch'); end if;
  select count(*) into actual from memory_v1.source_versions sv join memory_v1.source_records sr using(workspace_id,source_record_id)
    where sr.workspace_id=requested_workspace_id and sr.ingestion_run_id=requested_ingestion_run_id and sv.pipeline_version=requested_pipeline_version and sv.source_family='native_export';
  if actual<>976 then errors:=array_append(errors,'source_version_count_mismatch'); end if;
  select count(*) into actual from memory_v1.messages m join memory_v1.source_records sr using(workspace_id,source_record_id)
    where sr.workspace_id=requested_workspace_id and sr.ingestion_run_id=requested_ingestion_run_id and m.source_version_id is not null;
  if actual is distinct from run_row.expected_message_count then errors:=array_append(errors,'message_count_mismatch'); end if;
  select count(*) into actual from memory_v1.content_blocks b join memory_v1.source_records sr using(workspace_id,source_record_id)
    where sr.workspace_id=requested_workspace_id and sr.ingestion_run_id=requested_ingestion_run_id and b.source_version_id is not null;
  if actual is distinct from run_row.expected_content_block_count then errors:=array_append(errors,'content_block_count_mismatch'); end if;
  if exists (select 1 from memory_v1.source_versions sv join memory_v1.source_records sr using(workspace_id,source_record_id)
    where sr.workspace_id=requested_workspace_id and sr.ingestion_run_id=requested_ingestion_run_id
      and (sv.source_container_sha256<>'4cdfcdd3b55e4a391575ac41f08871bcc07c8742cc907a0d3603e25299aade12'
        or sv.source_metadata->>'conversations_json_sha256'<>'f57c63428e85e53a1f3cbcae5eb85c77ba1be616ca3438d6fd9e5bc217ec4fb6'))
    then errors:=array_append(errors,'source_identity_mismatch'); end if;
  if (select count(*) from memory_v1.verification_results vr join memory_v1.source_versions sv using(workspace_id,source_version_id)
      join memory_v1.source_records sr on sr.workspace_id=sv.workspace_id and sr.source_record_id=sv.source_record_id
      where sr.workspace_id=requested_workspace_id and sr.ingestion_run_id=requested_ingestion_run_id and vr.status='complete')<>976
    then errors:=array_append(errors,'verification_distribution_invalid'); end if;
  if (select count(*) from memory_v1.provenance_edges p join memory_v1.source_records sr using(workspace_id,source_record_id)
      where sr.workspace_id=requested_workspace_id and sr.ingestion_run_id=requested_ingestion_run_id and p.source_version_id is not null)
     is distinct from run_row.expected_content_block_count then errors:=array_append(errors,'provenance_count_mismatch'); end if;
  if exists (select 1 from memory_v1.archive_hash_resolutions a join memory_v1.source_versions sv using(workspace_id,source_version_id)
    join memory_v1.source_records sr on sr.workspace_id=sv.workspace_id and sr.source_record_id=sv.source_record_id
    where sr.workspace_id=requested_workspace_id and sr.ingestion_run_id=requested_ingestion_run_id and not a.exact_match)
    then errors:=array_append(errors,'hash_resolution_mismatch'); end if;
  select count(*) into actual from memory_v1.archive_hash_resolutions
    where workspace_id=requested_workspace_id and ingestion_run_id=requested_ingestion_run_id
      and pipeline_version=requested_pipeline_version and source_version_id is not null and exact_match;
  if actual is distinct from coalesce(run_row.expected_content_block_count,0)+976
    then errors:=array_append(errors,'hash_resolution_count_mismatch'); end if;
  if run_row.fatal_error_count<>0 then errors:=array_append(errors,'fatal_error_count_nonzero'); end if;
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
  if exists (select 1 from memory_v1.knowledge_extraction_runs where workspace_id=requested_workspace_id and extraction_run_id=requested_ingestion_run_id and pipeline_version=requested_pipeline_version) then
    return memory_v1.knowledge_extraction_completion_errors(requested_workspace_id,requested_ingestion_run_id,requested_pipeline_version);
  end if;
  if exists (select 1 from memory_v1.source_versions sv join memory_v1.source_records sr using(workspace_id,source_record_id)
    where sr.workspace_id=requested_workspace_id and sr.ingestion_run_id=requested_ingestion_run_id and sv.pipeline_version=requested_pipeline_version and sv.source_family='native_export') then
    return memory_v1.native_export_completion_errors(requested_workspace_id,requested_ingestion_run_id,requested_pipeline_version);
  end if;
  return memory_v1.capture_ingestion_completion_errors(requested_workspace_id,requested_ingestion_run_id,requested_pipeline_version);
end $$;

revoke all on function memory_v1.native_export_completion_errors(text,text,memory_v1.pipeline_version) from public;
grant execute on function memory_v1.native_export_completion_errors(text,text,memory_v1.pipeline_version)
  to memory_v1_ingest_writer,memory_v1_report_reader;
