import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe,it,expect,afterEach} from 'vitest';
import {publishAuditStatus,readAuditStatus,acknowledgeAuditReview} from './reconstruction-audit-status.mjs';
const operation='operation_'+'a'.repeat(32),workspace='historical-fixture',source='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const actor='11111111-1111-4111-8111-111111111111',roots=[];
afterEach(()=>{for(const root of roots.splice(0)){if(!path.resolve(root).startsWith(path.join(os.tmpdir(),'audit-review-')))throw Error('Unexpected cleanup path');fs.rmSync(root,{recursive:true,force:true});}});
const put=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'audit-review-'));roots.push(root);
 const report={schema_version:'hhs-cached-recovery-audit/1',operation_id:operation,source,phase:'review_required',original_generator_verified:false,
  all_current_evidence_matched:true,replay_new_rows:0,new_user_authority_risks:0,missing_provenance:0,changed_existing_runtime_files:0,
  artifact_flags:[],all_findings_trusted_validated:3,all_findings_persisted_match:3,prior_user_authority_risks:106,remaining_user_authority_risks:106,
  prior_exact_duplicate_groups:0,remaining_exact_duplicate_groups:0,private_source:'DO NOT EXPOSE'};
 const lineage={operation_id:operation,source,deferred_links:2,original:{original_input_sha256:'b'.repeat(64),original_output_sha256:'c'.repeat(64),generating_model_provenance:'unverified'}};
 const reportFile=path.join(root,'.runtime/reconstruction/cached-recovery',operation,'audit.json');
 put(reportFile,report);put(path.join(path.dirname(reportFile),'lineage.json'),lineage);
 const status={workspace,operation_id:operation,phase:'review_required',continuation:'paused',updated_at:'2026-10-20T13:00:00Z',checked_findings:3,sampled_findings:3,advisory_issues:2,blocking_issues:0};
 publishAuditStatus(root,status);
 const input={operation_id:operation,revision:readAuditStatus(root,workspace,operation).review.revision,reviewer_ref:actor,rationale:'I accept these limitations for private historical exploration.',acknowledge_limitations:true};
 return{root,report,reportFile,status,input};
}
describe('narrow append-only cached-recovery review',()=>{
 it('shows bounded reasons, preserves original audit and records review without claiming a pass or resuming',()=>{
  const f=fixture(),rawFile=path.join(f.root,'.runtime/reconstruction/audit-receipts',operation+'.json'),before=fs.readFileSync(rawFile,'utf8');
  const visible=readAuditStatus(f.root,workspace,operation);
  expect(visible.review.can_acknowledge).toBe(true);expect(visible.review.reasons).toHaveLength(2);expect(JSON.stringify(visible)).not.toContain('DO NOT EXPOSE');
  const result=acknowledgeAuditReview(f.root,workspace,f.input);
  expect(result).toMatchObject({operation_id:operation,continuation:'paused',replay:false});
  expect(readAuditStatus(f.root,workspace,operation)).toMatchObject({phase:'reviewed',continuation:'paused',review:{can_acknowledge:false,rationale:f.input.rationale}});
  expect(fs.readFileSync(rawFile,'utf8')).toBe(before);
  const replay=acknowledgeAuditReview(f.root,workspace,f.input);expect(replay).toMatchObject({replay:true,recorded_at:result.recorded_at});
  expect(fs.readdirSync(path.join(f.root,'.runtime/reconstruction/audit-receipts/reviews'))).toHaveLength(1);
  expect(()=>acknowledgeAuditReview(f.root,workspace,{...f.input,rationale:'A different decision must not overwrite the first.'})).toThrow('review_conflict');
 });
 it('rejects stale revisions, scope swaps, false consent, extra fields and malformed identities',()=>{
  const f=fixture();
  for(const input of [{...f.input,revision:'d'.repeat(64)},{...f.input,revision:[f.input.revision]},{...f.input,operation_id:'../outside'},
   {...f.input,acknowledge_limitations:false},{...f.input,reviewer_ref:'not-user'},{...f.input,rationale:'short'},{...f.input,command:'resume'}])expect(()=>acknowledgeAuditReview(f.root,workspace,input)).toThrow();
  expect(()=>acknowledgeAuditReview(f.root,'another-workspace',f.input)).toThrow();
  expect(fs.existsSync(path.join(f.root,'.runtime/reconstruction/audit-receipts/reviews'))).toBe(false);
 });
 it('cannot acknowledge a blocking, failed, live or incomplete audit',()=>{
  for(const change of [{blocking_issues:1},{phase:'failed'},{phase:'coherence'},{continuation:'automatic'},{checked_findings:4}]){
   const f=fixture();publishAuditStatus(f.root,{...f.status,...change});
   const current=readAuditStatus(f.root,workspace,operation);expect(current.review.can_acknowledge).toBe(false);
   expect(()=>acknowledgeAuditReview(f.root,workspace,{...f.input,revision:current.review.revision})).toThrow('review_changed_or_blocked');
  }
  for(const change of [{all_current_evidence_matched:false},{new_user_authority_risks:1},{missing_provenance:1},{artifact_flags:[{severity:'blocking'}]},
   {all_findings_persisted_match:2},{changed_existing_runtime_files:1}]){
   const f=fixture();put(f.reportFile,{...f.report,...change});const current=readAuditStatus(f.root,workspace,operation);
   expect(current.review.can_acknowledge).toBe(false);
   expect(()=>acknowledgeAuditReview(f.root,workspace,{...f.input,revision:current.review.revision})).toThrow();
  }
 });
 it('changed audit evidence invalidates the former review and preserves its receipt',()=>{
  const f=fixture();acknowledgeAuditReview(f.root,workspace,f.input);
  put(f.reportFile,{...f.report,new_user_authority_risks:1});
  const changed=readAuditStatus(f.root,workspace,operation);expect(changed.phase).toBe('review_required');expect(changed.review.can_acknowledge).toBe(false);
  expect(changed.review.revision).not.toBe(f.input.revision);
  expect(fs.readdirSync(path.join(f.root,'.runtime/reconstruction/audit-receipts/reviews'))).toHaveLength(1);
  expect(()=>acknowledgeAuditReview(f.root,workspace,f.input)).toThrow();
 });
});
