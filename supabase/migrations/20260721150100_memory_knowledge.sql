create table memory_v1.knowledge_candidates (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  knowledge_candidate_id text not null, chunk_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  kind text not null check (kind in ('claim','idea','entity','relationship','use_case','decision','task','sop')),
  status text not null check (status = 'proposed'),
  proposed_value jsonb not null, proposed_value_sha256 memory_v1.sha256 not null, created_at timestamptz not null,
  primary key (workspace_id, knowledge_candidate_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, chunk_id) references memory_v1.message_range_chunks(workspace_id, chunk_id)
);

create table memory_v1.provenance_edges (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  provenance_edge_id text not null, idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  target_record_type text not null check (target_record_type = 'knowledge_candidate'), target_record_id text not null,
  relation text not null check (relation in ('derived_from','quotes','supports','contradicts')),
  source_record_id text not null, capture_version_id text not null, conversation_id text not null,
  message_id text not null, content_block_id text not null, representation_kind text not null,
  representation_sha256 memory_v1.sha256 not null, created_at timestamptz not null,
  primary key (workspace_id, provenance_edge_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, source_record_id) references memory_v1.source_records(workspace_id, source_record_id),
  foreign key (workspace_id, capture_version_id) references memory_v1.capture_versions(workspace_id, capture_version_id),
  foreign key (workspace_id, conversation_id) references memory_v1.conversations(workspace_id, conversation_id),
  foreign key (workspace_id, message_id) references memory_v1.messages(workspace_id, message_id),
  foreign key (workspace_id, content_block_id) references memory_v1.content_blocks(workspace_id, content_block_id),
  foreign key (workspace_id, target_record_id) references memory_v1.knowledge_candidates(workspace_id, knowledge_candidate_id)
);

create table memory_v1.candidate_evidence (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  candidate_evidence_id text not null, knowledge_candidate_id text not null, provenance_edge_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  role text not null check (role in ('supporting','contradicting','context')),
  primary key (workspace_id, candidate_evidence_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, knowledge_candidate_id) references memory_v1.knowledge_candidates(workspace_id, knowledge_candidate_id),
  foreign key (workspace_id, provenance_edge_id) references memory_v1.provenance_edges(workspace_id, provenance_edge_id)
);

create table memory_v1.human_review_events (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  human_review_event_id text not null, knowledge_candidate_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  actor_kind text not null check (actor_kind = 'human'), reviewer_id text not null,
  from_status text not null, to_status text not null, rationale text not null,
  occurred_at timestamptz not null, event_sha256 memory_v1.sha256 not null,
  primary key (workspace_id, human_review_event_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, knowledge_candidate_id) references memory_v1.knowledge_candidates(workspace_id, knowledge_candidate_id)
);

create table memory_v1.approved_knowledge (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  approved_knowledge_id text not null, knowledge_candidate_id text not null, approval_event_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  approved_value jsonb not null, approved_value_sha256 memory_v1.sha256 not null,
  provenance_edge_ids jsonb not null check (jsonb_typeof(provenance_edge_ids) = 'array'), approved_at timestamptz not null,
  primary key (workspace_id, approved_knowledge_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, knowledge_candidate_id) references memory_v1.knowledge_candidates(workspace_id, knowledge_candidate_id),
  foreign key (workspace_id, approval_event_id) references memory_v1.human_review_events(workspace_id, human_review_event_id)
);

create table memory_v1.entities (
  workspace_id text not null references memory_v1.workspaces(workspace_id), entity_id text not null,
  approved_knowledge_id text not null, idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  entity_type text not null, canonical_name text not null,
  primary key (workspace_id, entity_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, approved_knowledge_id) references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id)
);
create table memory_v1.relationships (
  workspace_id text not null references memory_v1.workspaces(workspace_id), relationship_id text not null,
  approved_knowledge_id text not null, subject_id text not null, object_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null, relationship_kind text not null,
  primary key (workspace_id, relationship_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, approved_knowledge_id) references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id),
  foreign key (workspace_id, subject_id) references memory_v1.entities(workspace_id, entity_id),
  foreign key (workspace_id, object_id) references memory_v1.entities(workspace_id, entity_id)
);

create table memory_v1.contradictions (
  workspace_id text not null references memory_v1.workspaces(workspace_id), contradiction_id text not null,
  left_record_id text not null, right_record_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  status text not null check (status in ('proposed','confirmed','resolved')), provenance_edge_ids jsonb not null,
  primary key (workspace_id, contradiction_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, left_record_id) references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id),
  foreign key (workspace_id, right_record_id) references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id)
);
create table memory_v1.supersessions (
  workspace_id text not null references memory_v1.workspaces(workspace_id), supersession_id text not null,
  prior_approved_knowledge_id text not null, successor_approved_knowledge_id text not null, human_review_event_id text not null,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null, provenance_edge_ids jsonb not null,
  primary key (workspace_id, supersession_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, prior_approved_knowledge_id) references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id),
  foreign key (workspace_id, successor_approved_knowledge_id) references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id),
  foreign key (workspace_id, human_review_event_id) references memory_v1.human_review_events(workspace_id, human_review_event_id)
);

create table memory_v1.use_cases (
  workspace_id text not null references memory_v1.workspaces(workspace_id), use_case_id text not null,
  approved_knowledge_id text not null, idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  provenance_edge_ids jsonb not null, name text not null, outcome text not null,
  primary key (workspace_id, use_case_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, approved_knowledge_id) references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id)
);
create table memory_v1.decisions (
  workspace_id text not null references memory_v1.workspaces(workspace_id), decision_id text not null,
  approved_knowledge_id text not null, idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  provenance_edge_ids jsonb not null, statement text not null, decision_status text not null,
  primary key (workspace_id, decision_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, approved_knowledge_id) references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id)
);
create table memory_v1.tasks (
  workspace_id text not null references memory_v1.workspaces(workspace_id), task_id text not null,
  approved_knowledge_id text not null, idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  provenance_edge_ids jsonb not null, title text not null, task_status text not null,
  primary key (workspace_id, task_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, approved_knowledge_id) references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id)
);
create table memory_v1.sops (
  workspace_id text not null references memory_v1.workspaces(workspace_id), sop_id text not null,
  approved_knowledge_id text not null, idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  provenance_edge_ids jsonb not null, title text not null, ordered_steps jsonb not null,
  primary key (workspace_id, sop_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, approved_knowledge_id) references memory_v1.approved_knowledge(workspace_id, approved_knowledge_id)
);

create table memory_v1.quarantine_items (
  workspace_id text not null references memory_v1.workspaces(workspace_id), quarantine_item_id text not null,
  ingestion_run_id text not null, source_record_id text,
  idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  reason_code text not null, payload_sha256 memory_v1.sha256 not null,
  status text not null check (status in ('open','released','discarded')), created_at timestamptz not null default now(),
  primary key (workspace_id, quarantine_item_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, ingestion_run_id) references memory_v1.ingestion_runs(workspace_id, ingestion_run_id),
  foreign key (workspace_id, source_record_id) references memory_v1.source_records(workspace_id, source_record_id)
);
create table memory_v1.dead_letters (
  workspace_id text not null references memory_v1.workspaces(workspace_id), dead_letter_id text not null,
  ingestion_run_id text not null, idempotency_key memory_v1.sha256 not null, record_sha256 memory_v1.sha256 not null,
  operation text not null, payload_sha256 memory_v1.sha256 not null, failure_code text not null,
  attempt_count integer not null check (attempt_count > 0), next_retry_at timestamptz,
  primary key (workspace_id, dead_letter_id), unique (workspace_id, idempotency_key),
  foreign key (workspace_id, ingestion_run_id) references memory_v1.ingestion_runs(workspace_id, ingestion_run_id)
);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'workspaces','source_systems','source_accounts','ingestion_runs','source_records','capture_versions',
    'conversations','messages','content_blocks','verification_results','ingestion_checkpoints','message_range_chunks',
    'archive_hash_resolutions','knowledge_candidates','provenance_edges','candidate_evidence','human_review_events',
    'approved_knowledge','entities','relationships','contradictions','supersessions','use_cases','decisions','tasks',
    'sops','quarantine_items','dead_letters'
  ] loop
    execute format('alter table memory_v1.%I enable row level security', table_name);
    execute format(
      'create policy workspace_isolation on memory_v1.%I using (workspace_id = current_setting(''memory_v1.workspace_id'', true)) with check (workspace_id = current_setting(''memory_v1.workspace_id'', true))',
      table_name
    );
  end loop;
end $$;

create view memory_v1.import_report as
select w.workspace_id, w.name as workspace_name, r.ingestion_run_id, r.status as run_status,
       c.capture_version_id, c.verification_status, c.manifest_sha256,
       (select count(*) from memory_v1.messages m
         where m.workspace_id=w.workspace_id and m.capture_version_id=c.capture_version_id) as message_count,
       (select count(*) from memory_v1.content_blocks b
         where b.workspace_id=w.workspace_id and b.capture_version_id=c.capture_version_id) as content_block_count,
       (select count(*) from memory_v1.message_range_chunks ch
         where ch.workspace_id=w.workspace_id and ch.capture_version_id=c.capture_version_id) as chunk_count,
       (select count(*) from memory_v1.knowledge_candidates k
         join memory_v1.message_range_chunks ch
           on ch.workspace_id=k.workspace_id and ch.chunk_id=k.chunk_id
         where k.workspace_id=w.workspace_id and ch.ingestion_run_id=r.ingestion_run_id and k.status='proposed') as proposed_candidate_count,
       (select count(*) from memory_v1.provenance_edges p
         join memory_v1.knowledge_candidates k
           on k.workspace_id=p.workspace_id and k.knowledge_candidate_id=p.target_record_id
         join memory_v1.message_range_chunks ch
           on ch.workspace_id=k.workspace_id and ch.chunk_id=k.chunk_id
         where p.workspace_id=w.workspace_id and ch.ingestion_run_id=r.ingestion_run_id) as provenance_edge_count,
       (select count(*) from memory_v1.archive_hash_resolutions a
         where a.workspace_id=w.workspace_id and a.capture_version_id=c.capture_version_id and a.exact_match) as exact_hash_resolution_count,
       (select count(*) from memory_v1.quarantine_items q
         where q.workspace_id=w.workspace_id and q.ingestion_run_id=r.ingestion_run_id) as quarantine_count,
       (select count(*) from memory_v1.approved_knowledge ak
         where ak.workspace_id=w.workspace_id) as approved_knowledge_count
from memory_v1.workspaces w
join memory_v1.ingestion_runs r using (workspace_id)
join memory_v1.capture_versions c
  on c.workspace_id=r.workspace_id and c.manifest_sha256=r.input_manifest_sha256;
