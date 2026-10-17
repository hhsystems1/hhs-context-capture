import {describe,it,expect} from 'vitest';
import {sha256} from '@hhs/memory-schema';
import type {DbClient} from './db.js';
import {assertBrowserUserTextCoverage,prepareDiscoveryExchangeFromClient,BROWSER_USER_TEXT_COVERAGE_SQL} from './understanding-discovery.js';
const text='No, build the platform itself.';
const row={text_value:text,representation_sha256:sha256(text),block_texts:[text]};
describe('original browser user evidence coverage',()=>{
 it('accepts full preserved text and rejects missing or partial blocks before generation',()=>{expect(()=>assertBrowserUserTextCoverage([row])).not.toThrow();for(const block_texts of [[],['the platform']])expect(()=>assertBrowserUserTextCoverage([{...row,block_texts}])).toThrow('repair source evidence');expect(()=>assertBrowserUserTextCoverage([{...row,text_value:'changed'}])).toThrow('hash');expect(()=>assertBrowserUserTextCoverage([{...row,text_value:'',representation_sha256:sha256(''),block_texts:[]}])).not.toThrow();});
 it('stops the actual existing export before evidence generation for an authorized incomplete browser source',async()=>{let reads=0;const client={query:async(sql:string)=>{reads++;if(reads===1)return{rows:[{source_conversation_id:'browser-source',source_family:'browser_capture',capture_version_id:'capture_1'}]};expect(sql).toBe(BROWSER_USER_TEXT_COVERAGE_SQL);return{rows:[{...row,block_texts:[]}]};}} as unknown as DbClient;await expect(prepareDiscoveryExchangeFromClient(client,'workspace_1',['browser-source'])).rejects.toThrow('repair source evidence');expect(reads).toBe(2);});
});
