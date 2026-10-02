create or replace view memory_v1.import_report with (security_invoker=true) as
select w.workspace_id, w.name as workspace_name, r.ingestion_run_id, r.pipeline_version,
       r.status as run_status, r.completion_validated_at,
       c.capture_version_id, c.verification_status, c.manifest_sha256,
       (select count(*) from memory_v1.messages m
         where m.workspace_id=w.workspace_id and m.capture_version_id=c.capture_version_id) as message_count,
       (select count(*) from memory_v1.content_blocks b
         where b.workspace_id=w.workspace_id and b.capture_version_id=c.capture_version_id) as content_block_count,
       (select count(*) from memory_v1.message_range_chunks ch
         where ch.workspace_id=w.workspace_id and ch.ingestion_run_id=r.ingestion_run_id
           and ch.pipeline_version=r.pipeline_version) as chunk_count,
       (select count(*) from memory_v1.knowledge_candidates k
         join memory_v1.message_range_chunks ch
           on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
         where k.workspace_id=w.workspace_id and ch.ingestion_run_id=r.ingestion_run_id
           and ch.pipeline_version=r.pipeline_version and k.status='proposed') as proposed_candidate_count,
       (select count(*) from memory_v1.provenance_edges p
         join memory_v1.knowledge_candidates k
           on (k.workspace_id,k.knowledge_candidate_id,k.pipeline_version)=(p.workspace_id,p.target_record_id,p.pipeline_version)
         join memory_v1.message_range_chunks ch
           on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version)
         where p.workspace_id=w.workspace_id and ch.ingestion_run_id=r.ingestion_run_id
           and ch.pipeline_version=r.pipeline_version) as provenance_edge_count,
       (select count(*) from memory_v1.archive_hash_resolutions a
         where a.workspace_id=w.workspace_id
           and (a.ingestion_run_id=r.ingestion_run_id or (a.ingestion_run_id is null and r.pipeline_version='memory-v1/legacy'))
           and a.pipeline_version=r.pipeline_version and a.capture_version_id=c.capture_version_id and a.exact_match) as exact_hash_resolution_count,
       (select count(*) from memory_v1.quarantine_items q
         where q.workspace_id=w.workspace_id and q.ingestion_run_id=r.ingestion_run_id
           and q.pipeline_version=r.pipeline_version) as quarantine_count,
       (select count(*) from memory_v1.approved_knowledge ak
         where ak.workspace_id=w.workspace_id and ak.pipeline_version=r.pipeline_version) as approved_knowledge_count
from memory_v1.workspaces w
join memory_v1.ingestion_runs r using (workspace_id)
join memory_v1.capture_versions c
  on c.workspace_id=r.workspace_id and c.manifest_sha256=r.input_manifest_sha256;
