
import{describe,it,expect}from'vitest';import{explicitVideoPreference,parseCoreChatMessage,coreMessageIdentity,proposeCoreChatPreferenceFromClient}from'./core-chat-preference.js';import type{DbClient}from'./db.js';
const target='11111111-1111-4111-8111-111111111111';const message={authorId:target,threadId:'22222222-2222-4222-8222-222222222222',messageId:'33333333-3333-4333-8333-333333333333',orgId:'44444444-4444-4444-8444-444444444444',createdAt:'2026-10-19T10:00:00.000Z',content:'I prefer conversational and direct wording. Remember this style for future videos.'};
describe('native Core chat preference source adapter',()=>{
 it('requires explicit future intent and binds exact native author/message/date',()=>{
  expect(explicitVideoPreference(message.content)).toBe(true);expect(explicitVideoPreference('Less corporate.')).toBe(false);for(const text of ['Remember this style for future videos.','Do not remember this style for future videos.','Corporate videos are lame, by the way. Remember this for future videos.'])expect(explicitVideoPreference(text)).toBe(false);
  expect(parseCoreChatMessage({message},target)).toEqual(message);expect(()=>parseCoreChatMessage({message:{...message,authorId:message.orgId}},target)).toThrow();expect(()=>parseCoreChatMessage({message,workspaceId:'forged'},target)).toThrow();
  const identity=coreMessageIdentity('workspace_'+'a'.repeat(32),message);expect(identity.snapshot.source_created_at).toBe(message.createdAt);expect(identity.snapshot.scope).toBe('single_user_message');expect(identity.snapshot.role).toBe('user');expect(identity.native).toContain(message.threadId);expect(identity.native).toContain(message.messageId);
 });
 it('rejects edits to already-preserved native message identity before acquiring another archive',async()=>{
  let archived=0;const client={query:async(sql:string)=>sql.includes('select content_sha256')?{rowCount:1,rows:[{content_sha256:'a'.repeat(64)}]}:{rowCount:0,rows:[]}} as unknown as DbClient;
  await expect(proposeCoreChatPreferenceFromClient(client,{sourceRef:'history',sourceWorkspaceId:'proof',destinationWorkspaceId:'workspace_'+'a'.repeat(32),targetRef:target},message,async()=>{archived++;return{locator:'mock',sha256:'b'.repeat(64)};})).rejects.toMatchObject({code:'source_changed'});expect(archived).toBe(0);
 });
});
