-- Flexible understanding layer: immutable evidence -> observations -> links.
--
-- observation_kind and link_kind are intentionally free text. This migration
-- adds lifecycle and integrity constraints only; it does not establish an
-- ontology and it does not change approved-knowledge behavior.

create table memory_v1.observations (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  observation_id text not null,
  pipeline_version memory_v1.pipeline_version not null,
  observation_kind text not null check (length(btrim(observation_kind)) between 1 and 200),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_sha256 memory_v1.sha256 not null,
  idempotency_key memory_v1.sha256 not null,
  record_sha256 memory_v1.sha256 not null,
  status text not null check (status in ('proposed','reviewed','promoted','rejected')),
  chunk_id text,
  conversation_id text,
  created_at timestamptz not null,
  primary key (workspace_id, observation_id),
  unique (workspace_id, idempotency_key),
  unique (workspace_id, observation_id, pipeline_version),
  foreign key (workspace_id, chunk_id, pipeline_version)
    references memory_v1.message_range_chunks(workspace_id, chunk_id, pipeline_version),
  foreign key (workspace_id, conversation_id)
    references memory_v1.conversations(workspace_id, conversation_id)
);

create table memory_v1.observation_links (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  observation_link_id text not null,
  pipeline_version memory_v1.pipeline_version not null,
  from_observation_id text not null,
  to_observation_id text not null,
  link_kind text not null check (length(btrim(link_kind)) between 1 and 200),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  idempotency_key memory_v1.sha256 not null,
  record_sha256 memory_v1.sha256 not null,
  created_at timestamptz not null,
  primary key (workspace_id, observation_link_id),
  unique (workspace_id, idempotency_key),
  unique (workspace_id, observation_link_id, pipeline_version),
  foreign key (workspace_id, from_observation_id, pipeline_version)
    references memory_v1.observations(workspace_id, observation_id, pipeline_version),
  foreign key (workspace_id, to_observation_id, pipeline_version)
    references memory_v1.observations(workspace_id, observation_id, pipeline_version)
);

alter table memory_v1.observations enable row level security;
alter table memory_v1.observations force row level security;
create policy workspace_isolation on memory_v1.observations
  using (workspace_id=current_setting('memory_v1.workspace_id',true))
  with check (workspace_id=current_setting('memory_v1.workspace_id',true));

alter table memory_v1.observation_links enable row level security;
alter table memory_v1.observation_links force row level security;
create policy workspace_isolation on memory_v1.observation_links
  using (workspace_id=current_setting('memory_v1.workspace_id',true))
  with check (workspace_id=current_setting('memory_v1.workspace_id',true));

create trigger immutable_row_guard before update or delete on memory_v1.observations
  for each row execute function memory_v1.guard_immutable_row();
create trigger immutable_row_guard before update or delete on memory_v1.observation_links
  for each row execute function memory_v1.guard_immutable_row();

create index observations_conversation_idx
  on memory_v1.observations(workspace_id, conversation_id, pipeline_version);
create index observations_kind_idx
  on memory_v1.observations(workspace_id, observation_kind, pipeline_version);
create index observation_links_from_idx
  on memory_v1.observation_links(workspace_id, from_observation_id, pipeline_version);
create index observation_links_to_idx
  on memory_v1.observation_links(workspace_id, to_observation_id, pipeline_version);

revoke all on memory_v1.observations, memory_v1.observation_links from public;
grant select on memory_v1.observations, memory_v1.observation_links
  to memory_v1_ingest_writer, memory_v1_report_reader;
grant insert on memory_v1.observations, memory_v1.observation_links
  to memory_v1_ingest_writer;

-- Existing knowledge-candidate and source-evidence provenance remains intact.
-- Observation provenance is a third, explicit target type on the same exact
-- content-block evidence edge.
alter table memory_v1.provenance_edges
  drop constraint provenance_edges_target_record_type_check;
alter table memory_v1.provenance_edges
  add constraint provenance_edges_target_record_type_check
    check (target_record_type in ('knowledge_candidate','source_evidence','observation'));

create or replace function memory_v1.guard_provenance_target()
returns trigger language plpgsql
set search_path = memory_v1, pg_catalog
as $$
begin
  if new.target_record_type = 'knowledge_candidate' and not exists (
    select 1 from memory_v1.knowledge_candidates k
    where (k.workspace_id,k.knowledge_candidate_id,k.pipeline_version) =
          (new.workspace_id,new.target_record_id,new.pipeline_version)
  ) then
    raise exception using errcode='23503',
      message='provenance edge knowledge_candidate target does not exist';
  elsif new.target_record_type = 'observation' and not exists (
    select 1 from memory_v1.observations o
    where (o.workspace_id,o.observation_id,o.pipeline_version) =
          (new.workspace_id,new.target_record_id,new.pipeline_version)
  ) then
    raise exception using errcode='23503',
      message='provenance edge observation target does not exist';
  end if;
  return new;
end $$;
