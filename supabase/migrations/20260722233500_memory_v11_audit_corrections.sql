alter table memory_v1.ingestion_runs
  add column retry_of_ingestion_run_id text,
  add column retry_of_pipeline_version memory_v1.pipeline_version,
  add constraint ingestion_runs_retry_pair_check check (
    (retry_of_ingestion_run_id is null and retry_of_pipeline_version is null)
    or (retry_of_ingestion_run_id is not null and retry_of_pipeline_version is not null)
  ),
  add constraint ingestion_runs_retry_not_self_check check (
    retry_of_ingestion_run_id is null or retry_of_ingestion_run_id <> ingestion_run_id
  ),
  add constraint ingestion_runs_retry_parent_fk foreign key (
    workspace_id,retry_of_ingestion_run_id,retry_of_pipeline_version
  ) references memory_v1.ingestion_runs(workspace_id,ingestion_run_id,pipeline_version);

create or replace function memory_v1.guard_ingestion_run_transition() returns trigger
language plpgsql
set search_path = memory_v1, pg_catalog
as $$
declare errors text[]; parent_status text;
begin
  if tg_op='INSERT' then
    if new.status not in ('pending','running') then
      raise exception using errcode='23514', message='new ingestion runs must begin pending or running; completed INSERT is prohibited';
    end if;
    if new.completed_at is not null or new.completion_validated_at is not null then
      raise exception using errcode='23514', message='new ingestion runs cannot carry completion timestamps';
    end if;
    if new.retry_of_ingestion_run_id is not null then
      select status into parent_status from memory_v1.ingestion_runs
        where workspace_id=new.workspace_id
          and ingestion_run_id=new.retry_of_ingestion_run_id
          and pipeline_version=new.retry_of_pipeline_version;
      if parent_status is null then
        raise exception using errcode='23503', message='retry parent does not exist';
      end if;
      if parent_status not in ('failed','quarantined') then
        raise exception using errcode='23514', message='retry parent must be terminal failed or quarantined';
      end if;
    end if;
    return new;
  end if;
  if tg_op='DELETE' then raise exception using errcode='55000', message='ingestion runs cannot be deleted'; end if;
  if new.workspace_id<>old.workspace_id or new.ingestion_run_id<>old.ingestion_run_id
    or new.source_system_id<>old.source_system_id or new.source_account_id<>old.source_account_id
    or new.idempotency_key<>old.idempotency_key or new.input_manifest_sha256<>old.input_manifest_sha256
    or new.pipeline_version<>old.pipeline_version or new.started_at<>old.started_at
    or new.expected_message_count is distinct from old.expected_message_count
    or new.expected_content_block_count is distinct from old.expected_content_block_count
    or new.expected_chunk_count is distinct from old.expected_chunk_count
    or new.retry_of_ingestion_run_id is distinct from old.retry_of_ingestion_run_id
    or new.retry_of_pipeline_version is distinct from old.retry_of_pipeline_version then
    raise exception using errcode='55000', message='immutable ingestion run identity, lineage, or expectations cannot change';
  end if;
  if old.status in ('completed','quarantined') then
    raise exception using errcode='55000', message='completed and quarantined ingestion runs are terminal';
  end if;
  if new.attempt_count < old.attempt_count or new.fatal_error_count < old.fatal_error_count then
    raise exception using errcode='23514', message='ingestion counters cannot decrease';
  end if;
  if old.status<>new.status and not (
    (old.status='pending' and new.status in ('running','failed','quarantined')) or
    (old.status='running' and new.status in ('partial','failed','quarantined','completed')) or
    (old.status='partial' and new.status in ('running','failed','quarantined')) or
    (old.status='failed' and new.status='quarantined')
  ) then raise exception using errcode='23514', message='invalid or terminal ingestion status transition'; end if;
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
drop trigger ingestion_run_transition_guard on memory_v1.ingestion_runs;
create trigger ingestion_run_transition_guard before insert or update or delete on memory_v1.ingestion_runs
  for each row execute function memory_v1.guard_ingestion_run_transition();

create or replace function memory_v1.terminalize_fatal_quarantine() returns trigger
language plpgsql
set search_path = memory_v1, pg_catalog
as $$
begin
  update memory_v1.ingestion_runs
    set status='quarantined',fatal_error_count=fatal_error_count+1
    where workspace_id=new.workspace_id and ingestion_run_id=new.ingestion_run_id
      and pipeline_version=new.pipeline_version and status in ('pending','running','partial','failed');
  if not found and not exists (
    select 1 from memory_v1.ingestion_runs where workspace_id=new.workspace_id
      and ingestion_run_id=new.ingestion_run_id and pipeline_version=new.pipeline_version and status='quarantined'
  ) then raise exception using errcode='23514', message='fatal quarantine could not terminalize its ingestion run'; end if;
  return new;
end $$;
create trigger fatal_quarantine_terminalizer after insert on memory_v1.quarantine_items
  for each row when (new.fatal) execute function memory_v1.terminalize_fatal_quarantine();

create table memory_v1.legacy_provenance_repairs (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  provenance_repair_id text not null,
  provenance_edge_id text not null,
  pipeline_version memory_v1.pipeline_version not null,
  original_source_record_id text not null,
  corrected_source_record_id text not null,
  content_block_id text not null,
  representation_kind text not null,
  representation_sha256 memory_v1.sha256 not null,
  archive_resolution_id text not null,
  repair_sha256 memory_v1.sha256 not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id,provenance_repair_id),
  unique (workspace_id,provenance_edge_id,pipeline_version),
  foreign key (workspace_id,provenance_edge_id,pipeline_version)
    references memory_v1.provenance_edges(workspace_id,provenance_edge_id,pipeline_version),
  foreign key (workspace_id,original_source_record_id)
    references memory_v1.source_records(workspace_id,source_record_id),
  foreign key (workspace_id,corrected_source_record_id)
    references memory_v1.source_records(workspace_id,source_record_id),
  foreign key (workspace_id,content_block_id)
    references memory_v1.content_blocks(workspace_id,content_block_id),
  foreign key (workspace_id,archive_resolution_id,pipeline_version)
    references memory_v1.archive_hash_resolutions(workspace_id,resolution_id,pipeline_version),
  check (pipeline_version='memory-v1/legacy'),
  check (original_source_record_id<>corrected_source_record_id)
);

insert into memory_v1.legacy_provenance_repairs (
  workspace_id,provenance_repair_id,provenance_edge_id,pipeline_version,original_source_record_id,
  corrected_source_record_id,content_block_id,representation_kind,representation_sha256,
  archive_resolution_id,repair_sha256
)
select p.workspace_id,
  'provenance_repair_' || substr(encode(extensions.digest(convert_to(
    p.workspace_id || ':' || p.provenance_edge_id || ':' || b.source_record_id || ':' || p.representation_sha256,'UTF8'),'sha256'),'hex'),1,32),
  p.provenance_edge_id,p.pipeline_version,p.source_record_id,b.source_record_id,p.content_block_id,
  p.representation_kind,p.representation_sha256,a.resolution_id,
  encode(extensions.digest(convert_to(
    p.provenance_edge_id || ':' || p.source_record_id || ':' || b.source_record_id || ':' ||
    p.content_block_id || ':' || p.representation_kind || ':' || p.representation_sha256 || ':' || a.resolution_id,
    'UTF8'),'sha256'),'hex')
from memory_v1.provenance_edges p
join memory_v1.content_blocks b
  on (b.workspace_id,b.content_block_id)=(p.workspace_id,p.content_block_id)
join memory_v1.archive_hash_resolutions a
  on a.workspace_id=b.workspace_id and a.pipeline_version=p.pipeline_version
    and a.source_record_id=b.source_record_id and a.capture_version_id=b.capture_version_id
    and a.expected_sha256=p.representation_sha256 and a.exact_match
where p.pipeline_version='memory-v1/legacy'
  and p.source_record_id<>b.source_record_id
  and b.representations @> jsonb_build_array(jsonb_build_object(
    'representation_kind',p.representation_kind,'sha256',p.representation_sha256));

do $$
declare edge_count integer; repair_count integer;
begin
  select count(*) into edge_count from memory_v1.provenance_edges where pipeline_version='memory-v1/legacy';
  select count(*) into repair_count from memory_v1.legacy_provenance_repairs;
  if edge_count<>450 or repair_count<>edge_count then
    raise exception using errcode='23514', message=format('legacy provenance repair coverage failed: edges=%s repairs=%s',edge_count,repair_count);
  end if;
end $$;

create table memory_v1.provenance_generation_attestations (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  ingestion_run_id text not null,
  pipeline_version memory_v1.pipeline_version not null,
  trust_status text not null check (trust_status in ('trusted','repaired','retired','quarantined')),
  reason_code text not null,
  evidence_sha256 memory_v1.sha256 not null,
  record_sha256 memory_v1.sha256 not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id,ingestion_run_id,pipeline_version),
  foreign key (workspace_id,ingestion_run_id,pipeline_version)
    references memory_v1.ingestion_runs(workspace_id,ingestion_run_id,pipeline_version)
);

insert into memory_v1.provenance_generation_attestations (
  workspace_id,ingestion_run_id,pipeline_version,trust_status,reason_code,evidence_sha256,record_sha256
)
select r.workspace_id,r.ingestion_run_id,r.pipeline_version,
  case when r.pipeline_version='memory-v1/legacy' then 'repaired'
       when r.status='completed' then 'trusted'
       when r.status='quarantined' then 'quarantined' else 'retired' end,
  case when r.pipeline_version='memory-v1/legacy' then 'legacy_block_source_overlay_verified'
       when r.status='completed' then 'completion_invariants_and_exact_provenance_verified'
       when r.status='quarantined' then 'terminal_fatal_quarantine' else 'non_completed_generation' end,
  case when r.pipeline_version='memory-v1/legacy' then (
    select encode(extensions.digest(convert_to(string_agg(x.repair_sha256,',' order by x.provenance_edge_id),'UTF8'),'sha256'),'hex')
      from memory_v1.legacy_provenance_repairs x where x.workspace_id=r.workspace_id
  ) else encode(extensions.digest(convert_to(
    r.workspace_id || ':' || r.ingestion_run_id || ':' || r.pipeline_version || ':' || r.status,'UTF8'),'sha256'),'hex') end,
  encode(extensions.digest(convert_to(
    r.workspace_id || ':' || r.ingestion_run_id || ':' || r.pipeline_version || ':' ||
    case when r.pipeline_version='memory-v1/legacy' then 'repaired'
         when r.status='completed' then 'trusted'
         when r.status='quarantined' then 'quarantined' else 'retired' end,
    'UTF8'),'sha256'),'hex')
from memory_v1.ingestion_runs r;

create or replace function memory_v1.attest_completed_generation(
  requested_workspace_id text,requested_ingestion_run_id text,requested_pipeline_version memory_v1.pipeline_version
) returns void
language plpgsql security definer
set search_path = memory_v1, pg_catalog
as $$
declare run_status text; errors text[]; evidence_hash memory_v1.sha256; body_hash memory_v1.sha256;
begin
  select status into run_status from memory_v1.ingestion_runs
    where workspace_id=requested_workspace_id and ingestion_run_id=requested_ingestion_run_id
      and pipeline_version=requested_pipeline_version;
  if run_status<>'completed' then raise exception using errcode='23514',message='only completed generations can be trusted'; end if;
  errors := memory_v1.ingestion_completion_errors(requested_workspace_id,requested_ingestion_run_id,requested_pipeline_version);
  if cardinality(errors)>0 then raise exception using errcode='23514',message='generation completion invariants are not satisfied'; end if;
  if exists (
    select 1 from memory_v1.provenance_edges p
    join memory_v1.knowledge_candidates k on (k.workspace_id,k.knowledge_candidate_id,k.pipeline_version)=(p.workspace_id,p.target_record_id,p.pipeline_version)
    join memory_v1.message_range_chunks ch on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
    join memory_v1.content_blocks b on (b.workspace_id,b.content_block_id)=(p.workspace_id,p.content_block_id)
    where ch.workspace_id=requested_workspace_id and ch.ingestion_run_id=requested_ingestion_run_id
      and ch.pipeline_version=requested_pipeline_version and p.source_record_id<>b.source_record_id
  ) then raise exception using errcode='23514',message='generation contains non-block provenance'; end if;
  select encode(extensions.digest(convert_to(string_agg(
    p.provenance_edge_id || ':' || p.source_record_id || ':' || p.representation_sha256,',' order by p.provenance_edge_id
  ),'UTF8'),'sha256'),'hex') into evidence_hash
  from memory_v1.provenance_edges p
  join memory_v1.knowledge_candidates k on (k.workspace_id,k.knowledge_candidate_id,k.pipeline_version)=(p.workspace_id,p.target_record_id,p.pipeline_version)
  join memory_v1.message_range_chunks ch on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
  where ch.workspace_id=requested_workspace_id and ch.ingestion_run_id=requested_ingestion_run_id
    and ch.pipeline_version=requested_pipeline_version;
  body_hash := encode(extensions.digest(convert_to(
    requested_workspace_id || ':' || requested_ingestion_run_id || ':' || requested_pipeline_version || ':trusted:' || evidence_hash,
    'UTF8'),'sha256'),'hex');
  insert into memory_v1.provenance_generation_attestations (
    workspace_id,ingestion_run_id,pipeline_version,trust_status,reason_code,evidence_sha256,record_sha256
  ) values (requested_workspace_id,requested_ingestion_run_id,requested_pipeline_version,'trusted',
    'completion_invariants_and_exact_provenance_verified',evidence_hash,body_hash)
  on conflict (workspace_id,ingestion_run_id,pipeline_version) do nothing;
end $$;

create view memory_v1.trusted_provenance_edges with (security_invoker=true) as
select p.workspace_id,p.provenance_edge_id,p.idempotency_key,p.record_sha256,
  p.target_record_type,p.target_record_id,p.relation,
  case when att.trust_status='repaired' then repair.corrected_source_record_id else p.source_record_id end as source_record_id,
  p.source_record_id as historical_source_record_id,p.capture_version_id,p.conversation_id,p.message_id,
  p.content_block_id,p.representation_kind,p.representation_sha256,p.created_at,p.pipeline_version,
  att.ingestion_run_id,att.trust_status,repair.provenance_repair_id,a.resolution_id as archive_resolution_id
from memory_v1.provenance_edges p
join memory_v1.knowledge_candidates k
  on (k.workspace_id,k.knowledge_candidate_id,k.pipeline_version)=(p.workspace_id,p.target_record_id,p.pipeline_version)
join memory_v1.message_range_chunks ch
  on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
join memory_v1.provenance_generation_attestations att
  on (att.workspace_id,att.ingestion_run_id,att.pipeline_version)=(ch.workspace_id,ch.ingestion_run_id,ch.pipeline_version)
  and att.trust_status in ('trusted','repaired')
left join memory_v1.legacy_provenance_repairs repair
  on (repair.workspace_id,repair.provenance_edge_id,repair.pipeline_version)=(p.workspace_id,p.provenance_edge_id,p.pipeline_version)
join memory_v1.content_blocks b on (b.workspace_id,b.content_block_id)=(p.workspace_id,p.content_block_id)
join memory_v1.source_records s on s.workspace_id=p.workspace_id and s.source_record_id=
  case when att.trust_status='repaired' then repair.corrected_source_record_id else p.source_record_id end
join memory_v1.archive_hash_resolutions a
  on a.workspace_id=p.workspace_id and a.pipeline_version=p.pipeline_version
    and a.source_record_id=s.source_record_id and a.capture_version_id=p.capture_version_id
    and a.expected_sha256=p.representation_sha256 and a.exact_match
where b.source_record_id=s.source_record_id
  and b.representations @> jsonb_build_array(jsonb_build_object(
    'representation_kind',p.representation_kind,'sha256',p.representation_sha256))
  and ((att.trust_status='repaired' and repair.provenance_repair_id is not null)
    or (att.trust_status='trusted' and repair.provenance_repair_id is null));

create view memory_v1.trusted_knowledge_candidates with (security_invoker=true) as
select k.* from memory_v1.knowledge_candidates k
join memory_v1.message_range_chunks ch
  on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
join memory_v1.provenance_generation_attestations att
  on (att.workspace_id,att.ingestion_run_id,att.pipeline_version)=(ch.workspace_id,ch.ingestion_run_id,ch.pipeline_version)
  and att.trust_status in ('trusted','repaired')
where exists (select 1 from memory_v1.trusted_provenance_edges p
  where (p.workspace_id,p.target_record_id,p.pipeline_version)=(k.workspace_id,k.knowledge_candidate_id,k.pipeline_version))
and not exists (select 1 from memory_v1.provenance_edges raw
  where (raw.workspace_id,raw.target_record_id,raw.pipeline_version)=(k.workspace_id,k.knowledge_candidate_id,k.pipeline_version)
    and not exists (select 1 from memory_v1.trusted_provenance_edges trusted
      where (trusted.workspace_id,trusted.provenance_edge_id,trusted.pipeline_version)=(raw.workspace_id,raw.provenance_edge_id,raw.pipeline_version)));

alter table memory_v1.proof_receipts drop constraint proof_receipts_proof_kind_check;
alter table memory_v1.proof_receipts add constraint proof_receipts_proof_kind_check check (proof_kind in (
  'clean_first_ingestion','idempotent_replay','interrupted_resume','workspace_isolation',
  'invalid_evidence_quarantine','failure_cannot_complete','changed_pipeline_coexistence',
  'database_immutability','exact_provenance_resolution','completed_insert_rejection',
  'fatal_quarantine_terminal','retry_lineage','legacy_provenance_repair'
));

alter table memory_v1.legacy_provenance_repairs enable row level security;
alter table memory_v1.legacy_provenance_repairs force row level security;
create policy workspace_isolation on memory_v1.legacy_provenance_repairs
  using (workspace_id=current_setting('memory_v1.workspace_id',true))
  with check (workspace_id=current_setting('memory_v1.workspace_id',true));
alter table memory_v1.provenance_generation_attestations enable row level security;
alter table memory_v1.provenance_generation_attestations force row level security;
create policy workspace_isolation on memory_v1.provenance_generation_attestations
  using (workspace_id=current_setting('memory_v1.workspace_id',true))
  with check (workspace_id=current_setting('memory_v1.workspace_id',true));
create trigger immutable_row_guard before update or delete on memory_v1.legacy_provenance_repairs
  for each row execute function memory_v1.guard_immutable_row();
create trigger immutable_row_guard before update or delete on memory_v1.provenance_generation_attestations
  for each row execute function memory_v1.guard_immutable_row();

revoke all on memory_v1.legacy_provenance_repairs,memory_v1.provenance_generation_attestations from public;
grant select on memory_v1.legacy_provenance_repairs,memory_v1.provenance_generation_attestations,
  memory_v1.trusted_provenance_edges,memory_v1.trusted_knowledge_candidates
  to memory_v1_ingest_writer,memory_v1_report_reader;
revoke all on function memory_v1.attest_completed_generation(text,text,memory_v1.pipeline_version) from public;
grant execute on function memory_v1.attest_completed_generation(text,text,memory_v1.pipeline_version)
  to memory_v1_ingest_writer;

create or replace view memory_v1.import_report with (security_invoker=true) as
select w.workspace_id,w.name as workspace_name,r.ingestion_run_id,r.pipeline_version,
  r.status as run_status,r.completion_validated_at,c.capture_version_id,c.verification_status,c.manifest_sha256,
  (select count(*) from memory_v1.messages m where m.workspace_id=w.workspace_id and m.capture_version_id=c.capture_version_id) as message_count,
  (select count(*) from memory_v1.content_blocks b where b.workspace_id=w.workspace_id and b.capture_version_id=c.capture_version_id) as content_block_count,
  (select count(*) from memory_v1.message_range_chunks ch where ch.workspace_id=w.workspace_id and ch.ingestion_run_id=r.ingestion_run_id and ch.pipeline_version=r.pipeline_version) as chunk_count,
  (select count(*) from memory_v1.knowledge_candidates k join memory_v1.message_range_chunks ch on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version) where k.workspace_id=w.workspace_id and ch.ingestion_run_id=r.ingestion_run_id and ch.pipeline_version=r.pipeline_version and k.status='proposed') as proposed_candidate_count,
  (select count(*) from memory_v1.trusted_provenance_edges p where p.workspace_id=w.workspace_id and p.ingestion_run_id=r.ingestion_run_id and p.pipeline_version=r.pipeline_version) as provenance_edge_count,
  (select count(*) from memory_v1.archive_hash_resolutions a where a.workspace_id=w.workspace_id and (a.ingestion_run_id=r.ingestion_run_id or (a.ingestion_run_id is null and r.pipeline_version='memory-v1/legacy')) and a.pipeline_version=r.pipeline_version and a.capture_version_id=c.capture_version_id and a.exact_match) as exact_hash_resolution_count,
  (select count(*) from memory_v1.quarantine_items q where q.workspace_id=w.workspace_id and q.ingestion_run_id=r.ingestion_run_id and q.pipeline_version=r.pipeline_version) as quarantine_count,
  (select count(*) from memory_v1.approved_knowledge ak where ak.workspace_id=w.workspace_id and ak.pipeline_version=r.pipeline_version) as approved_knowledge_count,
  (select count(*) from memory_v1.provenance_edges p join memory_v1.knowledge_candidates k on (k.workspace_id,k.knowledge_candidate_id,k.pipeline_version)=(p.workspace_id,p.target_record_id,p.pipeline_version) join memory_v1.message_range_chunks ch on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version) where p.workspace_id=w.workspace_id and ch.ingestion_run_id=r.ingestion_run_id and ch.pipeline_version=r.pipeline_version) as raw_provenance_edge_count,
  att.trust_status as provenance_trust_status,r.retry_of_ingestion_run_id,r.retry_of_pipeline_version
from memory_v1.workspaces w
join memory_v1.ingestion_runs r using (workspace_id)
join memory_v1.capture_versions c on c.workspace_id=r.workspace_id and c.manifest_sha256=r.input_manifest_sha256
left join memory_v1.provenance_generation_attestations att
  on (att.workspace_id,att.ingestion_run_id,att.pipeline_version)=(r.workspace_id,r.ingestion_run_id,r.pipeline_version);

revoke all on memory_v1.import_report,memory_v1.trusted_provenance_edges,memory_v1.trusted_knowledge_candidates from public;
grant select on memory_v1.import_report,memory_v1.trusted_provenance_edges,memory_v1.trusted_knowledge_candidates
  to memory_v1_ingest_writer,memory_v1_report_reader;

create index ingestion_runs_retry_parent_idx on memory_v1.ingestion_runs(workspace_id,retry_of_ingestion_run_id,retry_of_pipeline_version);
create index legacy_provenance_repairs_edge_idx on memory_v1.legacy_provenance_repairs(workspace_id,provenance_edge_id,pipeline_version);
create index provenance_attestations_status_idx on memory_v1.provenance_generation_attestations(workspace_id,trust_status,pipeline_version);
