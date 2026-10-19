-- Extend existing completion verification for one explicit Core user-message snapshot.
-- Original export/capture/knowledge checks are retained below; no role or table change.
create or replace function memory_v1.ingestion_completion_errors(
  requested_workspace_id text,
  requested_ingestion_run_id text,
  requested_pipeline_version memory_v1.pipeline_version
) returns text[]
language plpgsql stable security definer
set search_path = memory_v1, pg_catalog
as $$
declare run_row memory_v1.ingestion_runs%rowtype; errors text[]:=array[]::text[]; version_row memory_v1.source_versions%rowtype;
begin
  if requested_pipeline_version='rivryn-chat-message/0.1.0' then
    if requested_workspace_id is distinct from current_setting('memory_v1.workspace_id',true) then return array['scope_denied']; end if;
    select * into run_row from memory_v1.ingestion_runs where workspace_id=requested_workspace_id and ingestion_run_id=requested_ingestion_run_id and pipeline_version=requested_pipeline_version;
    if not found then return array['run_missing']; end if;
    if run_row.expected_message_count is distinct from 1 or run_row.expected_content_block_count is distinct from 1 or run_row.expected_chunk_count is distinct from 0 or run_row.fatal_error_count<>0 then errors:=array_append(errors,'expectations_invalid'); end if;
    select sv.* into version_row from memory_v1.source_versions sv join memory_v1.source_records sr using(workspace_id,source_record_id)
      where sv.workspace_id=requested_workspace_id and sr.ingestion_run_id=requested_ingestion_run_id and sv.pipeline_version=requested_pipeline_version;
    if not found or version_row.source_family<>'rivryn_chat' or version_row.verification_status<>'complete' or version_row.source_metadata->>'scope' is distinct from 'single_user_message' or version_row.source_metadata->>'purpose' is distinct from 'video_communication_preference' then errors:=array_append(errors,'source_invalid'); end if;
    if not exists(select 1 from memory_v1.source_records sr where sr.workspace_id=requested_workspace_id and sr.source_record_id=version_row.source_record_id and sr.ingestion_run_id=requested_ingestion_run_id and sr.source_sha256=run_row.input_manifest_sha256) then errors:=array_append(errors,'manifest_hash_mismatch'); end if;
    if (select count(*) from memory_v1.source_versions sv join memory_v1.source_records sr using(workspace_id,source_record_id) where sv.workspace_id=requested_workspace_id and sr.ingestion_run_id=requested_ingestion_run_id)<>1 then errors:=array_append(errors,'version_count_mismatch'); end if;
    if (select count(*) from memory_v1.messages m where m.workspace_id=requested_workspace_id and m.source_version_id=version_row.source_version_id)<>1 then errors:=array_append(errors,'message_count_mismatch'); end if;
    if (select count(*) from memory_v1.messages m where m.workspace_id=requested_workspace_id and m.source_version_id=version_row.source_version_id and m.role='user' and m.source_created_at is not null and m.source_message_id=version_row.source_metadata->>'core_message_id')<>1 then errors:=array_append(errors,'message_invalid'); end if;
    if (select count(*) from memory_v1.content_blocks b where b.workspace_id=requested_workspace_id and b.source_version_id=version_row.source_version_id)<>1 then errors:=array_append(errors,'block_count_mismatch'); end if;
    if (select count(*) from memory_v1.content_blocks b cross join lateral jsonb_array_elements(b.representations) rep where b.workspace_id=requested_workspace_id and b.source_version_id=version_row.source_version_id and rep->>'representation_kind'='canonical_text' and coalesce(rep->>'value','')<>'')<>1 then errors:=array_append(errors,'representation_missing'); end if;
    if exists(select 1 from memory_v1.content_blocks b cross join lateral jsonb_array_elements(b.representations) rep where b.workspace_id=requested_workspace_id and b.source_version_id=version_row.source_version_id and rep->>'sha256'<>encode(extensions.digest(convert_to(rep->>'value','UTF8'),'sha256'),'hex')) then errors:=array_append(errors,'content_hash_mismatch'); end if;
    if (select count(*) from memory_v1.archive_hash_resolutions a where a.workspace_id=requested_workspace_id and a.ingestion_run_id=requested_ingestion_run_id and a.source_version_id=version_row.source_version_id and a.exact_match)<>2 then errors:=array_append(errors,'hash_resolution_count_mismatch'); end if;
    return errors;
  end if;
  if exists (select 1 from memory_v1.knowledge_extraction_runs where workspace_id=requested_workspace_id and extraction_run_id=requested_ingestion_run_id and pipeline_version=requested_pipeline_version) then
    return memory_v1.knowledge_extraction_completion_errors(requested_workspace_id,requested_ingestion_run_id,requested_pipeline_version);
  end if;
  if exists (select 1 from memory_v1.source_versions sv join memory_v1.source_records sr using(workspace_id,source_record_id)
    where sr.workspace_id=requested_workspace_id and sr.ingestion_run_id=requested_ingestion_run_id and sv.pipeline_version=requested_pipeline_version and sv.source_family='native_export') then
    return memory_v1.native_export_completion_errors(requested_workspace_id,requested_ingestion_run_id,requested_pipeline_version);
  end if;
  return memory_v1.capture_ingestion_completion_errors(requested_workspace_id,requested_ingestion_run_id,requested_pipeline_version);
end $$;
