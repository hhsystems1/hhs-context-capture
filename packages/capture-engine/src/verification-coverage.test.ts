import {it,expect} from 'vitest';
import type {ExtractedConversation} from './adapter-contract.js';
import {verifyCapture} from './verification.js';
const representation={kind:'canonical_text',value:'No, build the platform itself.',sha256:'a'.repeat(64)};
const fixture=(blocks:unknown[])=>({loadResult:{checks:[],warnings:[]},messages:[{sequence:0,role:'user',representations:[representation,representation,representation,representation],content_blocks:blocks,platform_metadata:{}}],branches:[],citations:[],attachments:[],artifacts:[],evidence:[]} as unknown as ExtractedConversation);
it('does not verify an empty/partial user-block projection as complete merely because all zero blocks are hashed',()=>{
 for(const blocks of [[],[{type:'paragraph',representations:[{...representation,value:'the platform'}]}]]){
  const result=verifyCapture(fixture(blocks));expect(result.status).toBe('needs_review');expect(result.checks.find(c=>c.check_id==='user_text.covered_by_blocks')?.status).toBe('fail');
 }
});
it('accepts original full message fallback coverage without claiming screenshot completeness',()=>{const result=verifyCapture(fixture([{type:'unknown',representations:[representation,representation,representation,representation]}]));expect(result.checks.find(c=>c.check_id==='user_text.covered_by_blocks')?.status).toBe('pass');expect(result.status).toBe('partial');});
