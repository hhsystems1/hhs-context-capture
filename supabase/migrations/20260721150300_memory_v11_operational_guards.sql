create or replace function memory_v1.guard_workspace_transition() returns trigger
language plpgsql
set search_path = memory_v1, pg_catalog
as $$
begin
  if tg_op='DELETE' then raise exception using errcode='55000', message='workspaces cannot be deleted'; end if;
  if new.workspace_id<>old.workspace_id or new.idempotency_key<>old.idempotency_key
    or new.record_sha256<>old.record_sha256 or new.name<>old.name
    or new.isolation_key<>old.isolation_key or new.created_at<>old.created_at then
    raise exception using errcode='55000', message='workspace identity and content are immutable';
  end if;
  if old.status='suspended' and new.status<>old.status then
    raise exception using errcode='23514', message='suspended workspace is terminal in Memory V1.1';
  end if;
  return new;
end $$;
create trigger workspace_transition_guard before update or delete on memory_v1.workspaces
  for each row execute function memory_v1.guard_workspace_transition();

create or replace function memory_v1.guard_quarantine_transition() returns trigger
language plpgsql
set search_path = memory_v1, pg_catalog
as $$
begin
  if tg_op='DELETE' then raise exception using errcode='55000', message='quarantine evidence cannot be deleted'; end if;
  if new.workspace_id<>old.workspace_id or new.quarantine_item_id<>old.quarantine_item_id
    or new.ingestion_run_id<>old.ingestion_run_id or new.source_record_id is distinct from old.source_record_id
    or new.idempotency_key<>old.idempotency_key or new.record_sha256<>old.record_sha256
    or new.reason_code<>old.reason_code or new.payload_sha256<>old.payload_sha256
    or new.created_at<>old.created_at or new.pipeline_version<>old.pipeline_version or new.fatal<>old.fatal then
    raise exception using errcode='55000', message='quarantine evidence content is immutable';
  end if;
  if old.status<>new.status and not (old.status='open' and new.status in ('released','discarded')) then
    raise exception using errcode='23514', message='invalid quarantine status transition';
  end if;
  return new;
end $$;
create trigger quarantine_transition_guard before update or delete on memory_v1.quarantine_items
  for each row execute function memory_v1.guard_quarantine_transition();

create or replace function memory_v1.guard_dead_letter_transition() returns trigger
language plpgsql
set search_path = memory_v1, pg_catalog
as $$
begin
  if tg_op='DELETE' then raise exception using errcode='55000', message='dead letters cannot be deleted'; end if;
  if new.workspace_id<>old.workspace_id or new.dead_letter_id<>old.dead_letter_id
    or new.ingestion_run_id<>old.ingestion_run_id or new.idempotency_key<>old.idempotency_key
    or new.record_sha256<>old.record_sha256 or new.operation<>old.operation
    or new.payload_sha256<>old.payload_sha256 or new.failure_code<>old.failure_code
    or new.pipeline_version<>old.pipeline_version or new.fatal<>old.fatal then
    raise exception using errcode='55000', message='dead-letter content is immutable';
  end if;
  if new.attempt_count<old.attempt_count then
    raise exception using errcode='23514', message='dead-letter attempts cannot decrease';
  end if;
  return new;
end $$;
create trigger dead_letter_transition_guard before update or delete on memory_v1.dead_letters
  for each row execute function memory_v1.guard_dead_letter_transition();

create index ingestion_runs_pipeline_status_idx on memory_v1.ingestion_runs(workspace_id,pipeline_version,status);
create index chunks_run_pipeline_idx on memory_v1.message_range_chunks(workspace_id,ingestion_run_id,pipeline_version,start_sequence);
create index resolutions_run_pipeline_idx on memory_v1.archive_hash_resolutions(workspace_id,ingestion_run_id,pipeline_version);
create index candidates_pipeline_chunk_idx on memory_v1.knowledge_candidates(workspace_id,pipeline_version,chunk_id);
create index provenance_pipeline_target_idx on memory_v1.provenance_edges(workspace_id,pipeline_version,target_record_id);
create index proof_receipts_pipeline_kind_idx on memory_v1.proof_receipts(workspace_id,pipeline_version,proof_kind);
