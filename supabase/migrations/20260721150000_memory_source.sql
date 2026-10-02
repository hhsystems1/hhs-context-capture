create extension if not exists vector with schema extensions;
create schema if not exists memory_v1;
create domain memory_v1.sha256 as text check (value ~ '^[0-9a-f]{64}$');

create table memory_v1.workspaces (
  workspace_id text primary key,
  idempotency_key memory_v1.sha256 not null unique,
  record_sha256 memory_v1.sha256 not null,
  name text not null,
  isolation_key text not null unique,
  status text not null check (status in ('active','suspended')),
  created_at timestamptz not null default now()
);

create table memory_v1.source_systems (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  source_system_id text not null,
  idempotency_key memory_v1.sha256 not null,
  record_sha256 memory_v1.sha256 not null,
  kind text not null,
  adapter_contract text not null,
  primary key (workspace_id, source_system_id), unique (workspace_id, idempotency_key)
);

create table memory_v1.source_accounts (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  source_account_id text not null, source_system_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  opaque_account_reference text not null,
  primary key (workspace_id, source_account_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, source_system_id) references memory_v1.source_systems(workspace_id, source_system_id)
);

create table memory_v1.ingestion_runs (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  ingestion_run_id text not null, source_system_id text not null, source_account_id text not null,
  idempotency_key memory_v1.sha256 not null,
  status text not null check (status in ('pending','running','completed','partial','failed','quarantined')),
  started_at timestamptz not null, completed_at timestamptz,
  input_manifest_sha256 memory_v1.sha256 not null, checkpoint_key text,
  attempt_count integer not null default 1 check (attempt_count > 0),
  primary key (workspace_id, ingestion_run_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, source_system_id) references memory_v1.source_systems(workspace_id, source_system_id),
  foreign key (workspace_id, source_account_id) references memory_v1.source_accounts(workspace_id, source_account_id)
);

create table memory_v1.source_records (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  source_record_id text not null, ingestion_run_id text not null, source_system_id text not null, source_account_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  source_native_id text not null,
  record_kind text not null check (record_kind in ('conversation','message','content_block','attachment','artifact','other')),
  immutable_evidence_locator text not null, source_sha256 memory_v1.sha256 not null, observed_at timestamptz not null,
  primary key (workspace_id, source_record_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, ingestion_run_id) references memory_v1.ingestion_runs(workspace_id, ingestion_run_id),
  foreign key (workspace_id, source_system_id) references memory_v1.source_systems(workspace_id, source_system_id),
  foreign key (workspace_id, source_account_id) references memory_v1.source_accounts(workspace_id, source_account_id)
);

create table memory_v1.capture_versions (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  capture_version_id text not null, source_record_id text not null, conversation_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  immutable_archive_locator text not null, manifest_sha256 memory_v1.sha256 not null,
  verification_status text not null check (verification_status in ('complete','partial','failed','needs_review')),
  captured_at timestamptz not null,
  primary key (workspace_id, capture_version_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, source_record_id) references memory_v1.source_records(workspace_id, source_record_id)
);

create table memory_v1.conversations (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  conversation_id text not null, source_record_id text not null, capture_version_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  source_conversation_id text not null, title_representation jsonb,
  primary key (workspace_id, conversation_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, source_record_id) references memory_v1.source_records(workspace_id, source_record_id),
  foreign key (workspace_id, capture_version_id) references memory_v1.capture_versions(workspace_id, capture_version_id) deferrable initially deferred
);
alter table memory_v1.capture_versions add constraint capture_version_conversation_fk
  foreign key (workspace_id, conversation_id) references memory_v1.conversations(workspace_id, conversation_id) deferrable initially deferred;

create table memory_v1.messages (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  message_id text not null, source_record_id text not null, conversation_id text not null, capture_version_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  source_message_id text not null, sequence integer not null check (sequence >= 0),
  role text not null check (role in ('user','assistant','tool','system_visible','unknown')),
  parent_message_id text, active_path boolean not null,
  representations jsonb not null check (jsonb_typeof(representations) = 'array'),
  primary key (workspace_id, message_id), unique (workspace_id, idempotency_key), unique (workspace_id, capture_version_id, sequence),
  foreign key (workspace_id, source_record_id) references memory_v1.source_records(workspace_id, source_record_id),
  foreign key (workspace_id, conversation_id) references memory_v1.conversations(workspace_id, conversation_id),
  foreign key (workspace_id, capture_version_id) references memory_v1.capture_versions(workspace_id, capture_version_id),
  foreign key (workspace_id, parent_message_id) references memory_v1.messages(workspace_id, message_id) deferrable initially deferred
);

create table memory_v1.content_blocks (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  content_block_id text not null, source_record_id text not null, message_id text not null, capture_version_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  sequence integer not null check (sequence >= 0), block_kind text not null,
  representations jsonb not null check (jsonb_typeof(representations) = 'array'),
  primary key (workspace_id, content_block_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, source_record_id) references memory_v1.source_records(workspace_id, source_record_id),
  foreign key (workspace_id, message_id) references memory_v1.messages(workspace_id, message_id),
  foreign key (workspace_id, capture_version_id) references memory_v1.capture_versions(workspace_id, capture_version_id)
);

create table memory_v1.verification_results (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  verification_result_id text not null, capture_version_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  ruleset_version text not null, status text not null check (status in ('complete','partial','failed','needs_review')),
  checks jsonb not null check (jsonb_typeof(checks) = 'array'), warnings jsonb not null default '[]'::jsonb,
  primary key (workspace_id, verification_result_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, capture_version_id) references memory_v1.capture_versions(workspace_id, capture_version_id)
);

create table memory_v1.ingestion_checkpoints (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  checkpoint_id text not null, ingestion_run_id text not null, checkpoint_key text not null,
  next_message_sequence integer not null check (next_message_sequence >= 0),
  completed_chunk_count integer not null check (completed_chunk_count >= 0),
  state_sha256 memory_v1.sha256 not null, updated_at timestamptz not null,
  primary key (workspace_id, checkpoint_id), unique (workspace_id, ingestion_run_id, checkpoint_key),
  foreign key (workspace_id, ingestion_run_id) references memory_v1.ingestion_runs(workspace_id, ingestion_run_id)
);

create table memory_v1.message_range_chunks (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  chunk_id text not null, ingestion_run_id text not null, capture_version_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  start_sequence integer not null, end_sequence integer not null check (end_sequence >= start_sequence),
  message_ids jsonb not null check (jsonb_typeof(message_ids) = 'array'), chunk_sha256 memory_v1.sha256 not null,
  primary key (workspace_id, chunk_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, ingestion_run_id) references memory_v1.ingestion_runs(workspace_id, ingestion_run_id),
  foreign key (workspace_id, capture_version_id) references memory_v1.capture_versions(workspace_id, capture_version_id)
);

create table memory_v1.archive_hash_resolutions (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  resolution_id text not null, source_record_id text not null, capture_version_id text not null,
  locator text not null, expected_sha256 memory_v1.sha256 not null, observed_sha256 memory_v1.sha256 not null,
  exact_match boolean generated always as (expected_sha256 = observed_sha256) stored,
  resolved_at timestamptz not null,
  primary key (workspace_id, resolution_id),
  foreign key (workspace_id, source_record_id) references memory_v1.source_records(workspace_id, source_record_id),
  foreign key (workspace_id, capture_version_id) references memory_v1.capture_versions(workspace_id, capture_version_id),
  check (expected_sha256 = observed_sha256)
);
