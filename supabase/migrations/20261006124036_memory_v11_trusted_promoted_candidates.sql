-- Issuance time is write-once but intentionally excluded from deterministic row hashes.
alter table memory_v1.promotion_receipts
  add column if not exists promoted_at timestamptz not null default now();

create or replace view memory_v1.trusted_knowledge_candidates with (security_invoker=true) as
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
      where (trusted.workspace_id,trusted.provenance_edge_id,trusted.pipeline_version)=(raw.workspace_id,raw.provenance_edge_id,raw.pipeline_version)))
union all
select k.* from memory_v1.knowledge_candidates k
join memory_v1.promotion_receipts p
  on (p.workspace_id,p.promotion_receipt_id,p.pipeline_version)=(k.workspace_id,k.promotion_receipt_id,k.pipeline_version)
where k.promotion_receipt_id is not null
  and p.kind=k.kind
  and p.promoted_value_sha256=k.proposed_value_sha256
  and p.promoted_value=k.proposed_value;

revoke all on memory_v1.trusted_knowledge_candidates from public;
grant select on memory_v1.trusted_knowledge_candidates
  to memory_v1_ingest_writer, memory_v1_report_reader;
