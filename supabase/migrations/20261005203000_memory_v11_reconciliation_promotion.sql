-- Memory V1.1 reconciliation and promotion boundary.
--
-- Existing source evidence, observations, provenance, extraction candidates,
-- review, and approved knowledge remain intact.
--
-- This migration adds:
--   source-workspace reconciliation records
--   same-workspace reconciliation -> observation lineage
--   destination-workspace promotion receipts
--   promotion-backed knowledge candidates
--
-- Normal provenance_edges remain workspace-local. Cross-workspace evidence is
-- represented only through immutable promotion receipts; it is never modeled
-- as a normal provenance edge.

create table memory_v1.reconciliations (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  reconciliation_id text not null,
  pipeline_version memory_v1.pipeline_version not null,

  kind text not null check (
    kind in ('claim','idea','entity','relationship','use_case','decision','task','sop')
  ),

  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_sha256 memory_v1.sha256 not null,

  idempotency_key memory_v1.sha256 not null,
  record_sha256 memory_v1.sha256 not null,
  created_at timestamptz not null,

  primary key (workspace_id, reconciliation_id),
  unique (workspace_id, idempotency_key),
  unique (workspace_id, reconciliation_id, pipeline_version)
);

create table memory_v1.reconciliation_observations (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  reconciliation_observation_id text not null,

  -- Pipeline of the reconciliation record itself.
  pipeline_version memory_v1.pipeline_version not null,

  reconciliation_id text not null,

  -- Observations can have been produced by a different pipeline version.
  observation_id text not null,
  observation_pipeline_version memory_v1.pipeline_version not null,

  relation text not null check (
    relation in (
      'supports',
      'contradicts',
      'refines',
      'supersedes',
      'duplicates',
      'context'
    )
  ),

  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),

  idempotency_key memory_v1.sha256 not null,
  record_sha256 memory_v1.sha256 not null,
  created_at timestamptz not null,

  primary key (workspace_id, reconciliation_observation_id),
  unique (workspace_id, idempotency_key),
  unique (workspace_id, reconciliation_observation_id, pipeline_version),

  foreign key (workspace_id, reconciliation_id, pipeline_version)
    references memory_v1.reconciliations(
      workspace_id,
      reconciliation_id,
      pipeline_version
    ),

  foreign key (
    workspace_id,
    observation_id,
    observation_pipeline_version
  )
    references memory_v1.observations(
      workspace_id,
      observation_id,
      pipeline_version
    )
);

-- A promotion receipt lives in the DESTINATION brain workspace.
--
-- source_lineage is intentionally not a foreign key into another workspace.
-- Trusted promotion code must validate every referenced source reconciliation
-- before this immutable attestation is written.
create table memory_v1.promotion_receipts (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  promotion_receipt_id text not null,
  pipeline_version memory_v1.pipeline_version not null,

  kind text not null check (
    kind in ('claim','idea','entity','relationship','use_case','decision','task','sop')
  ),

  -- Array entries identify source workspace/reconciliation identities,
  -- pipeline versions, immutable hashes, and any additional verified lineage
  -- required to re-check the promotion later.
  source_lineage jsonb not null
    check (
      jsonb_typeof(source_lineage) = 'array'
      and jsonb_array_length(source_lineage) > 0
    ),
  source_lineage_sha256 memory_v1.sha256 not null,

  promoted_value jsonb not null,
  promoted_value_sha256 memory_v1.sha256 not null,

  idempotency_key memory_v1.sha256 not null,
  record_sha256 memory_v1.sha256 not null,
  created_at timestamptz not null,

  primary key (workspace_id, promotion_receipt_id),
  unique (workspace_id, idempotency_key),
  unique (workspace_id, promotion_receipt_id, pipeline_version)
);

alter table memory_v1.reconciliations enable row level security;
alter table memory_v1.reconciliations force row level security;

alter table memory_v1.reconciliation_observations enable row level security;
alter table memory_v1.reconciliation_observations force row level security;

alter table memory_v1.promotion_receipts enable row level security;
alter table memory_v1.promotion_receipts force row level security;

create policy workspace_isolation on memory_v1.reconciliations
  using (workspace_id=current_setting('memory_v1.workspace_id',true))
  with check (workspace_id=current_setting('memory_v1.workspace_id',true));

create policy workspace_isolation on memory_v1.reconciliation_observations
  using (workspace_id=current_setting('memory_v1.workspace_id',true))
  with check (workspace_id=current_setting('memory_v1.workspace_id',true));

create policy workspace_isolation on memory_v1.promotion_receipts
  using (workspace_id=current_setting('memory_v1.workspace_id',true))
  with check (workspace_id=current_setting('memory_v1.workspace_id',true));

create trigger immutable_row_guard
  before update or delete on memory_v1.reconciliations
  for each row execute function memory_v1.guard_immutable_row();

create trigger immutable_row_guard
  before update or delete on memory_v1.reconciliation_observations
  for each row execute function memory_v1.guard_immutable_row();

create trigger immutable_row_guard
  before update or delete on memory_v1.promotion_receipts
  for each row execute function memory_v1.guard_immutable_row();

create index reconciliations_kind_idx
  on memory_v1.reconciliations(
    workspace_id,
    kind,
    pipeline_version
  );

create index reconciliation_observations_reconciliation_idx
  on memory_v1.reconciliation_observations(
    workspace_id,
    reconciliation_id,
    pipeline_version
  );

create index reconciliation_observations_observation_idx
  on memory_v1.reconciliation_observations(
    workspace_id,
    observation_id,
    observation_pipeline_version
  );

create index promotion_receipts_kind_idx
  on memory_v1.promotion_receipts(
    workspace_id,
    kind,
    pipeline_version
  );

revoke all on
  memory_v1.reconciliations,
  memory_v1.reconciliation_observations,
  memory_v1.promotion_receipts
from public;

grant select on
  memory_v1.reconciliations,
  memory_v1.reconciliation_observations,
  memory_v1.promotion_receipts
to memory_v1_ingest_writer, memory_v1_report_reader;

grant insert on
  memory_v1.reconciliations,
  memory_v1.reconciliation_observations,
  memory_v1.promotion_receipts
to memory_v1_ingest_writer;

-- Legacy candidates come from message_range_chunks.
-- Reconciliation-backed candidates come from a promotion receipt.
-- Exactly one origin is required.
alter table memory_v1.knowledge_candidates
  add column promotion_receipt_id text;

alter table memory_v1.knowledge_candidates
  alter column chunk_id drop not null;

alter table memory_v1.knowledge_candidates
  add constraint knowledge_candidates_single_origin_chk
  check (num_nonnulls(chunk_id, promotion_receipt_id) = 1);

alter table memory_v1.knowledge_candidates
  add constraint knowledge_candidates_promotion_pipeline_fk
  foreign key (
    workspace_id,
    promotion_receipt_id,
    pipeline_version
  )
  references memory_v1.promotion_receipts(
    workspace_id,
    promotion_receipt_id,
    pipeline_version
  );

create index knowledge_candidates_promotion_idx
  on memory_v1.knowledge_candidates(
    workspace_id,
    promotion_receipt_id,
    pipeline_version
  )
  where promotion_receipt_id is not null;

-- A promotion-backed candidate must be an exact representation of its receipt.
-- The receipt is evidence of what crossed the workspace boundary; the candidate
-- may not silently change its kind or proposed value after promotion.
create or replace function memory_v1.guard_knowledge_candidate_origin()
returns trigger
language plpgsql
set search_path = memory_v1, pg_catalog
as $$
declare
  receipt_kind text;
  receipt_value jsonb;
  receipt_value_sha256 memory_v1.sha256;
begin
  if num_nonnulls(new.chunk_id, new.promotion_receipt_id) <> 1 then
    raise exception using
      errcode='23514',
      message='knowledge candidate must have exactly one origin';
  end if;

  if new.promotion_receipt_id is not null then
    select
      p.kind,
      p.promoted_value,
      p.promoted_value_sha256
    into
      receipt_kind,
      receipt_value,
      receipt_value_sha256
    from memory_v1.promotion_receipts p
    where p.workspace_id = new.workspace_id
      and p.promotion_receipt_id = new.promotion_receipt_id
      and p.pipeline_version = new.pipeline_version;

    if not found then
      raise exception using
        errcode='23503',
        message='knowledge candidate promotion receipt does not exist';
    end if;

    if receipt_kind is distinct from new.kind then
      raise exception using
        errcode='23514',
        message='knowledge candidate kind does not match promotion receipt';
    end if;

    if receipt_value_sha256 is distinct from new.proposed_value_sha256
       or receipt_value is distinct from new.proposed_value then
      raise exception using
        errcode='23514',
        message='knowledge candidate value does not match promotion receipt';
    end if;
  end if;

  return new;
end $$;

create trigger knowledge_candidate_origin_guard
  before insert on memory_v1.knowledge_candidates
  for each row execute function memory_v1.guard_knowledge_candidate_origin();
