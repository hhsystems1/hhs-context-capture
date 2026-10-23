import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { createPool, immutableInsert, type DbClient } from './db.js';
import { immutableRow } from './review.js';
import { CORE_CHAT_PIPELINE, coreMessageIdentity, proposeCoreChatPreferenceFromClient } from './core-chat-preference.js';
import { APPROVED_KNOWLEDGE_QUERY_SQL } from './query.js';
import { sha256 } from '@hhs/memory-schema';
describe.skipIf(process.env.HHS_RUN_CORE_CHAT_DB_PROOF !== '1')('native Core message completion guard (always rolled back)', () => {
  it('requires native user evidence, blocks, exact content hashes, scope and review; replay creates no second candidate', async () => {
    const pool=createPool('admin'), client=await pool.connect(), workspace='workspace_'+'c'.repeat(32), user='11111111-1111-4111-8111-111111111111';
    const message={authorId:user,orgId:'22222222-2222-4222-8222-222222222222',threadId:'33333333-3333-4333-8333-333333333333',messageId:'44444444-4444-4444-8444-444444444444',createdAt:'2026-10-19T00:00:00.000Z',content:'Keep videos conversational and direct. Remember this style for future videos.'};
    const grant={sourceRef:'synthetic',sourceWorkspaceId:'fixture-history',destinationWorkspaceId:workspace,targetRef:user};
    const archive=async(snapshot:Record<string,unknown>)=>({locator:'hhs-fixture://core-message',sha256:sha256(JSON.stringify(snapshot))});
    const errors=async(run:string,scope=workspace)=> (await client.query('select memory_v1.ingestion_completion_errors($1,$2,$3) errors',[scope,run,CORE_CHAT_PIPELINE])).rows[0].errors as string[];
    try {
      await client.query('begin');
      await client.query(await readFile('supabase/migrations/20261019134826_rivryn_chat_evidence_completion.sql','utf8'));
      await client.query("select set_config('memory_v1.workspace_id',$1,true)",[workspace]);
      await immutableInsert(client,'workspaces','workspace_id',immutableRow('workspace',workspace,'fixture',{workspace_id:workspace,name:'Rollback fixture',isolation_key:workspace,status:'active',created_at:message.createdAt}));
      const first=await proposeCoreChatPreferenceFromClient(client,grant,message,archive), replay=await proposeCoreChatPreferenceFromClient(client,grant,message,archive);
      expect(replay.knowledge_candidate_id).toBe(first.knowledge_candidate_id);expect(replay.replay).toBe(true);
      expect((await client.query(APPROVED_KNOWLEDGE_QUERY_SQL,[workspace,'video script communication preference',5])).rowCount).toBe(0);
      const run=coreMessageIdentity(workspace,message).id('ingestion_run');expect(await errors(run)).toEqual([]);
      expect(await errors('missing')).toContain('run_missing');expect(await errors(run,'workspace_'+'b'.repeat(32))).toContain('scope_denied');
      for (const [stop,expected,corrupt] of [['messages','message_count_mismatch',false],['content_blocks','block_count_mismatch',false],['archive_hash_resolutions','hash_resolution_count_mismatch',false],['archive_hash_resolutions','content_hash_mismatch',true]] as const) {
        await client.query('savepoint incomplete');
        const input={...message,messageId:'55555555-5555-4555-8555-555555555555'};
        const partial={query:async(sql:string,values?:unknown[])=>{
          if(sql.startsWith('insert into memory_v1.'+stop))throw Error('fixture_interrupted');
          if(corrupt&&sql.startsWith('insert into memory_v1.content_blocks')){
            const columns=sql.slice(sql.indexOf('(')+1,sql.indexOf(')')).split(','), index=columns.indexOf('representations'), next=[...values!];
            const reps=JSON.parse(next[index] as string);reps[0].sha256='a'.repeat(64);next[index]=JSON.stringify(reps);return client.query(sql,next);
          }
          return client.query(sql,values);
        }} as unknown as DbClient;
        await expect(proposeCoreChatPreferenceFromClient(partial,grant,input,archive)).rejects.toThrow('fixture_interrupted');
        expect(await errors(coreMessageIdentity(workspace,input).id('ingestion_run'))).toContain(expected);
        await client.query('rollback to savepoint incomplete');
      }
    } finally { await client.query('rollback');client.release();await pool.end(); }
  });
});
