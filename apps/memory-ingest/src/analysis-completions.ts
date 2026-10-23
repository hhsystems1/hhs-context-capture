import{sha256}from'@hhs/memory-schema';
import type{DbClient}from'./db.js';

// The existing transactionally committed, validated discovery rows are the
// durable completion signal. No file-write gap, new outbox or writable role.
export const COMPLETIONS_SQL=`select c.source_conversation_id,
 jsonb_agg(jsonb_build_object('id',o.observation_id,'sha256',o.record_sha256) order by o.observation_id) records
 from memory_v1.conversations c join memory_v1.observations o on o.workspace_id=c.workspace_id and o.conversation_id=c.conversation_id
 where c.workspace_id=$1 and o.pipeline_version='memory-understanding-discovery/0.2.0'
 and o.payload->>'discovery_exchange_id' is not null and ($2::text is null or c.source_conversation_id>$2)
 group by c.source_conversation_id order by c.source_conversation_id limit 51`;
export async function readCompletions(client:DbClient,workspace:string,cursor?:string){
 const r=await client.query(COMPLETIONS_SQL,[workspace,cursor??null]);
 const completions=r.rows.slice(0,50).map(row=>{const records=row.records as Array<{id:string;sha256:string}>;if(!records.length||records.length>600)throw Error('Completion record limit');return{conversation:String(row.source_conversation_id),records,findings:records.length,fingerprint:sha256(records.map(r=>[r.id,r.sha256]))};});
 return{view:'completions' as const,completions,next_cursor:r.rows.length>50?completions.at(-1)!.conversation:null};
}
// Bounded lexical neighbor selection over the same existing observations.
// It fetches no source transcript and makes no new model call. Evidence gates
// remain in the established reader/inquiry, not in this ranking query.
export const RELATED_SQL=`with changed as (
 select o.payload->>'statement' statement from memory_v1.observations o join memory_v1.conversations c
 on c.workspace_id=o.workspace_id and c.conversation_id=o.conversation_id
 where c.workspace_id=$1 and c.source_conversation_id=$2 and o.pipeline_version='memory-understanding-discovery/0.2.0'),
 terms as (select term,count(*) n from changed,regexp_split_to_table(lower(statement),'[^a-z0-9]+') term
 where length(term) between 4 and 40 and not(term=any(array['user','stephen','assistant','wanted','wants','requested','request','asked','that','this','with','from','have','about','should','would','could','their','there','they','them','into','what','when','where','which','were','been','being','need','needs','also','using','used','more','than','make','does','will','conversation','historical','information','system','systems']))
 group by term order by count(*) desc,term limit 24),ranked as (
 select c.source_conversation_id,c.title_representation->>'value' title,count(distinct o.observation_id)::int observations_count,count(distinct terms.term) score
 from memory_v1.conversations c join memory_v1.observations o on o.workspace_id=c.workspace_id and o.conversation_id=c.conversation_id
 join terms on position(terms.term in lower(coalesce(o.payload->>'statement','')))>0
 where c.workspace_id=$1 and c.source_conversation_id<>$2 and o.pipeline_version='memory-understanding-discovery/0.2.0'
 group by c.source_conversation_id,c.title_representation)
 select source_conversation_id,title,observations_count from ranked order by score desc,source_conversation_id limit 8`;
export async function readRelated(client:DbClient,workspace:string,conversation:string){const r=await client.query(RELATED_SQL,[workspace,conversation]);return{view:'conversations' as const,conversations:r.rows.map(row=>({source_conversation_id:String(row.source_conversation_id),title:row.title===null?null:String(row.title),observations_count:Number(row.observations_count)})),next_cursor:null};}
