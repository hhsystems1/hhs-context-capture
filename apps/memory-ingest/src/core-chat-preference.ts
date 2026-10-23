// A source adapter for one explicit Core user declaration, not a chat crawler or
// preference store. All results use the existing evidence/discovery/review tables.
import { deterministicId, idempotencyKey, sha256 } from '@hhs/memory-schema';
import { archiveApplicationEvidence } from '@hhs/storage';
import { createPool, immutableInsert, transaction, type DbClient } from './db.js';
import { immutableRow } from './review.js';
import { BridgeError, exactKeys, type BrainGrant } from './brain-bridge-http.js';
import { reconcileAndPromoteFromClient } from './brain-integration-service.js';
import { UNDERSTANDING_DISCOVERY_PIPELINE_VERSION, UNDERSTANDING_INPUT_SCHEMA, UNDERSTANDING_OUTPUT_SCHEMA, validateDiscoveryOutput, persistValidatedDiscovery, type DiscoveryExchange, type DiscoveryEvidence } from './understanding-discovery.js';

export const CORE_CHAT_PIPELINE = 'rivryn-chat-message/0.1.0';
export const VIDEO_PREFERENCE_PREFIX = 'Video script communication preference: ';
export interface CoreChatMessage { threadId: string; messageId: string; orgId: string; authorId: string; createdAt: string; content: string }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export function futureVideoPreferenceIntent(text: string) {
  return text.length <= 2000 && /(?:^|[.!?\n])\s*(?:please\s+)?remember\b[^.!?\n]*\bfuture\s+videos?(?:\s+scripts?)?\b/i.test(text)
    && !/^\s*(?:[[{#>]|```)/.test(text);
}
export function explicitVideoPreference(text: string) {
  // A bare "remember this style" has no self-contained wording to preserve.
  // Ask for the actual preference rather than attributing an earlier AI draft.
  return futureVideoPreferenceIntent(text)
    && /\b(?:keep|make|use|write|speak|sound|prefer|want|avoid|remember)\b[^.!?\n]*\b(?:conversational|direct|corporate|formal|scripted|casual|friendly|warm|concise|jargon|plain language|short sentences)\b/i.test(text);
}
export function parseCoreChatMessage(body: Record<string, unknown>, target: string): CoreChatMessage {
  exactKeys(body, ['sourceRef','destinationWorkspaceId','targetRef','message']);
  const m=body.message;
  if(!m||typeof m!=='object'||Array.isArray(m))throw new BridgeError(400,'invalid_request');
  const row=m as Record<string,unknown>;exactKeys(row,['threadId','messageId','orgId','authorId','createdAt','content']);
  if(![row.threadId,row.messageId,row.orgId,row.authorId].every(uuid)||row.authorId!==target||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt))
    ||typeof row.content!=='string'||!explicitVideoPreference(row.content))throw new BridgeError(400,'invalid_request');
  return row as unknown as CoreChatMessage;
}

export function coreMessageIdentity(workspace: string, m: CoreChatMessage) {
  const native='rivryn_'+m.threadId+'_'+m.messageId;
  const id=(kind:string,part:unknown=m.messageId)=>deterministicId(kind,workspace,['rivryn_chat',m.authorId,part]);
  const snapshot={schema_version:CORE_CHAT_PIPELINE,source:'rivryn_chat',scope:'single_user_message',thread_id:m.threadId,message_id:m.messageId,organization_id:m.orgId,author_id:m.authorId,role:'user',source_created_at:m.createdAt,content:m.content};
  return {native,id,snapshot};
}

export async function proposeCoreChatPreferenceFromClient(client: DbClient, grant: BrainGrant, m: CoreChatMessage, archive=archiveApplicationEvidence) {
  // Core already read the row with user RLS; recheck destination/author here.
  if(m.authorId!==grant.targetRef||!explicitVideoPreference(m.content))throw new BridgeError(403,'scope_denied');
  const workspace=grant.destinationWorkspaceId,{native,id,snapshot}=coreMessageIdentity(workspace,m),at=m.createdAt;
  await client.query("select set_config('memory_v1.workspace_id',$1,true)",[workspace]);
  await client.query('set local statement_timeout=15000');
  await client.query('select pg_advisory_xact_lock($1::bigint)',[BigInt.asIntN(64,BigInt('0x'+sha256([workspace,m.messageId]).slice(0,16))).toString()]);
  const version=id('source_version'),conversation=id('conversation'),message=id('message'),block=id('content_block'),run=id('ingestion_run'),system=id('source_system','rivryn_chat'),account=id('source_account',m.authorId);
  const sourceRecord=id('source_record','conversation:'+m.messageId),messageRecord=id('source_record','message:'+m.messageId),blockRecord=id('source_record','block:'+m.messageId);
  const prior=await client.query('select content_sha256 from memory_v1.source_versions where workspace_id=$1 and source_version_id=$2',[workspace,version]);
  const contentHash=sha256(snapshot);
  if(prior.rowCount&&prior.rows[0].content_sha256!==contentHash)throw new BridgeError(409,'source_changed');
  const saved=await archive(snapshot);
  const locator=saved.locator,rep={representation_kind:'canonical_text',value:m.content,sha256:sha256(m.content),evidence_locator:locator+'#/content'};
  const row=(kind:string,natural:unknown,fields:Record<string,unknown>)=>immutableRow(kind,workspace,natural,{workspace_id:workspace,...fields});
  await immutableInsert(client,'source_systems','source_system_id',row('source_system',['rivryn_chat',m.authorId],{source_system_id:system,kind:'rivryn_chat',adapter_contract:CORE_CHAT_PIPELINE}));
  await immutableInsert(client,'source_accounts','source_account_id',row('source_account',m.authorId,{source_account_id:account,source_system_id:system,opaque_account_reference:m.authorId}));
  await client.query(`insert into memory_v1.ingestion_runs(workspace_id,ingestion_run_id,source_system_id,source_account_id,idempotency_key,status,started_at,input_manifest_sha256,checkpoint_key,pipeline_version,expected_message_count,expected_content_block_count,expected_chunk_count)
    values($1,$2,$3,$4,$5,'running',now(),$6,'source_foundation',$7,1,1,0) on conflict(workspace_id,ingestion_run_id) do nothing`,[workspace,run,system,account,idempotencyKey('ingestion_run',workspace,m.messageId),saved.sha256,CORE_CHAT_PIPELINE]);
  for(const [record,kind,nativeId,hash]of [[sourceRecord,'conversation',native,saved.sha256],[messageRecord,'message',m.messageId,rep.sha256],[blockRecord,'content_block',m.messageId+':text',rep.sha256]]){
    await immutableInsert(client,'source_records','source_record_id',row('source_record',record,{source_record_id:record,ingestion_run_id:run,source_system_id:system,source_account_id:account,source_native_id:nativeId,record_kind:kind,immutable_evidence_locator:kind==='conversation'?locator:rep.evidence_locator,source_sha256:hash,observed_at:at}));
  }
  await immutableInsert(client,'conversations','conversation_id',row('conversation',m.messageId,{conversation_id:conversation,source_record_id:sourceRecord,capture_version_id:null,source_version_id:null,source_conversation_id:native,title_representation:{representation_kind:'canonical_text',value:'RivRyn explicit video preference',sha256:sha256('RivRyn explicit video preference'),evidence_locator:locator+'#/message_id'}}));
  await immutableInsert(client,'source_versions','source_version_id',row('source_version',m.messageId,{source_version_id:version,pipeline_version:CORE_CHAT_PIPELINE,source_record_id:sourceRecord,conversation_id:conversation,source_family:'rivryn_chat',content_sha256:contentHash,immutable_source_locator:locator,source_container_sha256:null,verification_status:'complete',source_observed_at:at,source_metadata:{scope:'single_user_message',purpose:'video_communication_preference',core_thread_id:m.threadId,core_message_id:m.messageId,author_id:m.authorId,source_created_at:at},capture_version_id:null,created_at:at}));
  await immutableInsert(client,'messages','message_id',row('message',m.messageId,{message_id:message,source_record_id:messageRecord,conversation_id:conversation,capture_version_id:null,source_version_id:version,source_message_id:m.messageId,sequence:0,role:'user',parent_message_id:null,active_path:true,representations:[rep],source_created_at:at,source_updated_at:null}));
  await immutableInsert(client,'content_blocks','content_block_id',row('content_block',m.messageId,{content_block_id:block,source_record_id:blockRecord,message_id:message,capture_version_id:null,source_version_id:version,sequence:0,block_kind:'text',representations:[rep]}));
  const resolution=id('archive_hash_resolution');
  for(const [resolutionId,record,where,hash] of [[resolution,blockRecord,rep.evidence_locator,rep.sha256],[id('archive_hash_resolution','source:'+m.messageId),sourceRecord,locator,saved.sha256]]) {
    await client.query(`insert into memory_v1.archive_hash_resolutions(workspace_id,resolution_id,source_record_id,capture_version_id,locator,expected_sha256,observed_sha256,resolved_at,pipeline_version,ingestion_run_id,source_version_id)
      values($1,$2,$3,null,$4,$5,$5,$6,$7,$8,$9) on conflict(workspace_id,resolution_id) do nothing`,[workspace,resolutionId,record,where,hash,at,CORE_CHAT_PIPELINE,run,version]);
  }
  const evidence:DiscoveryEvidence={evidence_ref:'declared_preference',source_conversation_id:native,conversation_id:conversation,source_family:'rivryn_chat',source_version_id:version,capture_version_id:null,message_id:message,source_message_id:m.messageId,message_sequence:0,role:'user',active_path:true,content_block_id:block,block_kind:'text',representation_kind:'canonical_text',text:m.content,representation_sha256:rep.sha256,source_record_id:blockRecord,immutable_evidence_locator:rep.evidence_locator,source_record_sha256:rep.sha256,source_version_locator:locator,source_container_sha256:null,capture_locator:null,capture_manifest_sha256:null,resolution_id:resolution,resolution_expected_sha256:rep.sha256,resolution_observed_sha256:rep.sha256,resolution_exact:true,source_observed_at:at};
  const exchange:DiscoveryExchange={schema_version:UNDERSTANDING_INPUT_SCHEMA,pipeline_version:UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,exchange_id:id('discovery_exchange'),evidence_sha256:sha256([evidence]),created_at:at,selection:[{source_conversation_id:native,conversation_id:conversation,title:'RivRyn explicit video preference',source_family:'rivryn_chat',observed_at:at,message_count:1,content_characters:m.content.length,source_version_id:version,content_sha256:contentHash,immutable_source_locator:locator,source_container_sha256:null,capture_version_id:null,capture_manifest_sha256:null,capture_locator:null}],evidence:[evidence],model_instructions:{output_schema_version:UNDERSTANDING_OUTPUT_SCHEMA,observation_kinds_are_free_text:true,link_kinds_are_free_text:true,evidence_refs_are_authoritative:true,evidence_excerpts_are_optional:true,user_authority_requires_user_evidence:true,database_ids_or_hashes_required:false,model_metadata_required:false}};
  const validation=validateDiscoveryOutput(exchange,{schema_version:UNDERSTANDING_OUTPUT_SCHEMA,exchange_id:exchange.exchange_id,observations:[{observation_ref:'declared_preference',source_conversation_id:native,observation_kind:'creative_communication_preference',statement:m.content,payload:{scope:'future_video_scripts',explicit_future_intent:true},attribution:{subject:'user',claim_type:'preference'},confidence:1,evidence:[{evidence_ref:evidence.evidence_ref,excerpt:m.content}]}],links:[]},{provider:'user_declaration',name:'verbatim_user_message',runner_version:CORE_CHAT_PIPELINE});
  if(!validation.valid)throw new BridgeError(422,'preference_evidence_invalid');
  const discovery=await persistValidatedDiscovery(client,workspace,exchange,validation.valid);
  // Existing lifecycle, including authority checks and promotion receipts. No approval here.
  const promoted=await reconcileAndPromoteFromClient(client,{...grant,sourceWorkspaceId:workspace},{conversation:native,observationIds:[discovery.observation_ids.declared_preference!],statement:VIDEO_PREFERENCE_PREFIX+m.content,kind:'idea',temporalStatus:'current'});
  await client.query(`update memory_v1.ingestion_runs set status='completed',completed_at=now(),completion_validated_at=now(),checkpoint_key='complete' where workspace_id=$1 and ingestion_run_id=$2 and status='running'`,[workspace,run]);
  return promoted;
}
export async function proposeCoreChatPreference(grant:BrainGrant,message:CoreChatMessage){
  const pool=createPool('writer');try{return await transaction(pool,grant.destinationWorkspaceId,client=>proposeCoreChatPreferenceFromClient(client,grant,message));}finally{await pool.end();}
}
