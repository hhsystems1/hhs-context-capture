-- Approved knowledge already has an immutable, workspace-local candidate FK.
-- candidate -> promotion_receipt preserves lineage without another origin column.
-- Enforce exact promotion approval even for direct reviewer SQL writes.
create or replace function memory_v1.guard_promoted_knowledge_approval()
returns trigger language plpgsql
set search_path = memory_v1, pg_catalog
as $$
declare
  candidate memory_v1.knowledge_candidates%rowtype;
begin
  select * into candidate from memory_v1.knowledge_candidates k
  where (k.workspace_id,k.knowledge_candidate_id,k.pipeline_version) =
        (new.workspace_id,new.knowledge_candidate_id,new.pipeline_version);
  if not found then
    raise exception using errcode='23503', message='approved knowledge candidate does not exist at this pipeline version';
  end if;
  if candidate.promotion_receipt_id is not null then
    if new.approved_value is distinct from candidate.proposed_value
       or new.approved_value_sha256 is distinct from candidate.proposed_value_sha256
       or new.provenance_edge_ids <> '[]'::jsonb then
      raise exception using errcode='23514', message='promoted approval must retain exact receipt value and use receipt lineage';
    end if;
    if not exists (
      select 1 from memory_v1.human_review_events e
      where (e.workspace_id,e.human_review_event_id,e.pipeline_version) =
            (new.workspace_id,new.approval_event_id,new.pipeline_version)
        and e.knowledge_candidate_id=new.knowledge_candidate_id
        and e.to_status='approved' and e.actor_kind='human'
    ) then
      raise exception using errcode='23514', message='promoted approval requires matching human approval';
    end if;
  end if;
  return new;
end $$;

revoke all on function memory_v1.guard_promoted_knowledge_approval() from public;
grant execute on function memory_v1.guard_promoted_knowledge_approval()
  to memory_v1_reviewer, memory_v1_ingest_writer, memory_v1_report_reader;
drop trigger if exists promoted_knowledge_approval_guard on memory_v1.approved_knowledge;
create trigger promoted_knowledge_approval_guard
  before insert on memory_v1.approved_knowledge
  for each row execute function memory_v1.guard_promoted_knowledge_approval();
