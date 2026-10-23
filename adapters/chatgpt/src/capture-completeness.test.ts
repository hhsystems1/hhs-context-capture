import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {chromium,type Browser,type Page} from 'playwright';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import type {ChatGptAdapter,observeViewport} from './adapter.js';
import type {inspectChatGptPage} from './structure.js';
import type {verifyCapture} from '@hhs/capture-engine';
declare global { var HhsCompleteness:{ChatGptAdapter:typeof ChatGptAdapter;observeViewport:typeof observeViewport;inspectChatGptPage:typeof inspectChatGptPage;verifyCapture:typeof verifyCapture}; }
let browser:Browser,page:Page,bundle:string;
const conversation='33333333-3333-4333-8333-333333333333';
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'];
const pair=(user=ids[0]!,assistant=ids[1]!,image=false)=>`<div data-turn-key="${user}"><div><h4>You said:</h4><div class="group/user-message flex flex-col" data-chatgpt-search-message-ids="${user}">${image?'<div role="button"><img src="https://fixture.test/upload.png" alt="Uploaded image"></div>':'<div data-user-message-bubble="true"><p>Synthetic original request.</p></div>'}</div></div><div data-chatgpt-search-message-ids="${assistant} ${assistant}"><h4 data-conversation-role="assistant">Assistant said:</h4><div data-chatgpt-selection-message-id="${assistant}" data-chatgpt-selection-conversation-id="${conversation}"><div data-dil-message-id="${assistant}"><p>Synthetic reply.</p></div></div></div></div>`;
const html=(turns:string)=>`<main><div id="scroller" style="height:200px;overflow-y:auto"><div aria-label="Conversation">${turns}</div><div style="height:900px"></div></div></main>`;
beforeAll(async()=>{const repo=fileURLToPath(new URL('../../../',import.meta.url));const result=await build({absWorkingDir:repo,stdin:{contents:'export {ChatGptAdapter,observeViewport} from "@hhs/adapter-chatgpt";export {inspectChatGptPage} from "@hhs/adapter-chatgpt/structure";export {verifyCapture} from "@hhs/capture-engine";',resolveDir:repo},bundle:true,write:false,format:'iife',globalName:'HhsCompleteness',platform:'browser'});bundle=result.outputFiles[0]!.text;browser=await chromium.launch({headless:true});},20000);
afterAll(async()=>{await browser?.close();});
beforeEach(async()=>{await page?.close();page=await browser.newPage();await page.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:'<html><body></body></html>'}));await page.goto('https://fixture.test/c/'+conversation);await page.addScriptTag({content:bundle});});
const capture=()=>page.evaluate(async()=>{const api=globalThis.HhsCompleteness;const extracted=await new api.ChatGptAdapter().capture({document,sourceUrl:location.href,captureScreenshot:async()=>undefined,onProgress:()=>{}});return {extracted,verification:api.verifyCapture(extracted)};});

describe('native image-only user turns from preserved layout evidence',()=>{
 it('preserves the native user message and image reference even without a text bubble',async()=>{await page.setContent(html(pair(ids[0],ids[1],true)));const result=await capture();expect(result.extracted.messages.map(m=>[m.role,m.platform_message_id])).toEqual([['user',ids[0]],['assistant',ids[1]]]);expect(result.extracted.attachments).toMatchObject([{kind:'uploaded_image',related_message_id:ids[0],source_reference:'https://fixture.test/upload.png',availability:'referenced',evidence_locator:'chatgpt:message:'+ids[0],platform_metadata:{bytes_downloaded:false,reference_present:true}}]);const image=result.extracted.messages[0]!.content_blocks.find(block=>block.type==='image_reference')!;expect(image.attributes).toMatchObject({src:'https://fixture.test/upload.png',alt:'Uploaded image'});expect(image.representations.find(rep=>rep.kind==='sanitized_html')).toMatchObject({value:'<img src="https://fixture.test/upload.png" alt="Uploaded image">',evidence_locator:'chatgpt:message:'+ids[0]+':block:0'});expect(image.representations.every(rep=>/^[a-f0-9]{64}$/.test(rep.sha256))).toBe(true);expect(result.extracted.messages.map(message=>message.sequence)).toEqual([0,1]);expect(result.extracted.platformMetadata.turn_coverage).toMatchObject({observed:1,resolved:1,unresolved:0});expect(result.extracted.messages[0]!.representations.find(r=>r.kind==='canonical_text')!.value).not.toContain('Synthetic original request');},20000);
 it('requires the native turn binding and the separate provider user heading',async()=>{for(const value of [pair(ids[0],ids[1],true).replace('data-turn-key="'+ids[0]+'"','data-turn-key="'+ids[2]+'"'),pair(ids[0],ids[1],true).replace('You said:','Untrusted heading'),pair(ids[0],ids[1],true).replace('class="group/user-message flex flex-col"','class="arbitrary"')]){await page.setContent(html(value));const observed=await page.evaluate(()=>globalThis.HhsCompleteness.observeViewport(document));expect(observed.messages.filter(m=>m.role==='user')).toHaveLength(0);}});
 it('keeps image-loading placeholders unresolved instead of inventing a user payload',async()=>{await page.setContent(html(pair(ids[0],ids[1],true).replace('<div role="button"><img src="https://fixture.test/upload.png" alt="Uploaded image"></div>','<div class="motion-safe:animate-spin"></div>')));const result=await capture();expect(result.verification.status).toBe('needs_review');expect(result.extracted.platformMetadata.turn_coverage).toMatchObject({unresolved:1});expect(result.extracted.attachments).toHaveLength(0);},20000);
 it('does not duplicate a text-and-image user turn',async()=>{await page.setContent(html(pair().replace('<p>Synthetic original request.</p>','<p>Synthetic original request.</p><img src="https://fixture.test/upload.png">')));const result=await capture();expect(result.extracted.messages.map(m=>m.role)).toEqual(['user','assistant']);expect(result.extracted.attachments).toHaveLength(1);},20000);
});

describe('coverage after delayed boundary rendering',()=>{
 it('revisits a top boundary invalidated while its evidence was being recorded',async()=>{await page.setContent(html(pair(ids[2],ids[3])));const result=await page.evaluate(async({earlier,later})=>{const scroller=document.querySelector<HTMLElement>('#scroller')!,region=document.querySelector<HTMLElement>('[aria-label="Conversation"]')!;let prepended=false;const nativeScroll=scroller.scrollBy.bind(scroller);scroller.scrollBy=function(options?:ScrollToOptions|number,y?:number){if(typeof options==='number')nativeScroll(options,y??0);else nativeScroll(options);region.innerHTML=prepended&&scroller.scrollTop<100?earlier+later:later;};scroller.scrollTop=600;const api=globalThis.HhsCompleteness;const extracted=await new api.ChatGptAdapter().capture({document,sourceUrl:location.href,captureScreenshot:async portion=>{if(portion==='earliest_boundary'&&!prepended){prepended=true;scroller.scrollTop=400;}return undefined;},onProgress:()=>{}});return {extracted,verification:api.verifyCapture(extracted)};},{earlier:pair(),later:pair(ids[2],ids[3])});expect(result.extracted.messages.map(m=>m.platform_message_id)).toEqual(ids);expect(result.extracted.platformMetadata.source_coverage_baseline).toMatchObject({scope:'accessible_rendered_conversation',source_history_completeness:'not_established',coherent:true});},35000);
 it('does not declare coherent coverage when evidence repeatedly invalidates a boundary',async()=>{await page.setContent(html(pair()));const result=await page.evaluate(async()=>{const api=globalThis.HhsCompleteness,scroller=document.querySelector<HTMLElement>('#scroller')!;const extracted=await new api.ChatGptAdapter().capture({document,sourceUrl:location.href,captureScreenshot:async portion=>{if(portion==='earliest_boundary')scroller.scrollTop=400;return undefined;},onProgress:()=>{}});return {extracted,verification:api.verifyCapture(extracted)};});expect(result.verification.status).toBe('needs_review');expect(result.verification.checks.find(c=>c.check_id==='source.coverage_coherent')?.status).toBe('fail');expect(result.extracted.platformMetadata.source_coverage_baseline).toMatchObject({coherent:false,source_history_completeness:'not_established'});},35000);
 it('retains the unresolved expansion gate without clicking an unproved control',async()=>{await page.setContent(html(pair().replace('Synthetic original request.','Synthetic original request.<button onclick="window.__unsafeClick=true">Show more</button>')));const result=await capture();expect(result.verification.checks.find(c=>c.check_id==='content.not_truncated')?.status).toBe('fail');expect(await page.evaluate(()=>(window as unknown as {__unsafeClick?:boolean}).__unsafeClick)).toBeUndefined();},20000);
});


const fullClipText='Synthetic source text with original decisions, corrections and next steps. '.repeat(12);
const modernClip=(action='visual')=>{
 const extra:Record<string,string>={append:"this.previousElementSibling.firstElementChild.textContent+=' Newly loaded source text.';",async:"setTimeout(()=>this.previousElementSibling.firstElementChild.textContent+=' Delayed source text.',50);",loading:"this.previousElementSibling.setAttribute('aria-busy','true');"};
 const handler="window.__clipClicks=(window.__clipClicks||0)+1;"+(action==='stuck'?'':action==='removed'?'this.remove();':"this.setAttribute('aria-expanded','true');this.textContent='Show less';this.previousElementSibling.style.maxHeight='none';"+(extra[action]??''));
 return html(pair().replace('<p>Synthetic original request.</p>',`<div data-search-result-target style="max-height:48px;overflow:hidden;line-height:20px"><p>${fullClipText}</p></div><button aria-expanded="false" onclick="${handler}">Show more</button>`));
};


describe('verified loaded-text clipping in native user messages',()=>{
 it('verifies visual-only expansion only after its stable full source is preserved',async()=>{
  await page.setContent(modernClip());const result=await capture();
  expect(result.verification.status).toBe('complete');expect(result.extracted.messages.map(m=>[m.role,m.sequence])).toEqual([['user',0],['assistant',1]]);
  const proofs=result.extracted.platformMetadata.visual_expansion_verification as Array<{verified:boolean;preserved:boolean;before:{text_sha256:string};after:{text_sha256:string}}>;
  expect(proofs).toHaveLength(1);expect(proofs[0]).toMatchObject({message_id:ids[0],mode:'expanded',verified:true,preserved:true});expect(proofs[0]!.before.text_sha256).toBe(proofs[0]!.after.text_sha256);
  expect(result.extracted.messages[0]!.representations.find(r=>r.kind==='sanitized_html')!.value).toContain(fullClipText);
  expect(result.extracted.evidence.filter(e=>e.metadata?.reason==='visual_expansion_before'||e.metadata?.reason==='visual_expansion_after')).toHaveLength(2);
  expect(result.extracted.loadResult.checks.find(c=>c.check_id==='content.not_truncated')?.status).toBe('pass');expect(await page.evaluate(()=>(window as unknown as {__clipClicks:number}).__clipClicks)).toBe(1);
 },20000);
 it.each(['append','async','loading','stuck','removed'])('retains needs_review for %s content/expansion uncertainty',async action=>{
  await page.setContent(modernClip(action));const result=await capture();expect(result.verification.status).toBe('needs_review');expect(result.extracted.loadResult.checks.find(c=>c.check_id==='content.not_truncated')?.status).toBe('fail');
  expect((result.extracted.platformMetadata.visual_expansion_verification as Array<{verified:boolean}>).some(p=>!p.verified)).toBe(true);
 },20000);
 it('does not click empty, loading, or payload-embedded expansion controls',async()=>{
  for(const fixture of [modernClip().replace(fullClipText,''),modernClip().replace('data-search-result-target','aria-busy="true" data-search-result-target'),modernClip().replace('</p></div><button','</p><button').replace('</button>','</button></div>')]){
   await page.setContent(fixture);const result=await capture();expect(result.verification.status).toBe('needs_review');expect(await page.evaluate(()=>(window as unknown as {__clipClicks?:number}).__clipClicks)).toBeUndefined();
  }
 },35000);

 it('fails closed when verified content never reaches the preserved message',async()=>{
  await page.setContent(modernClip());const result=await page.evaluate(async()=>{const api=globalThis.HhsCompleteness;let removed=false;const extracted=await new api.ChatGptAdapter().capture({document,sourceUrl:location.href,captureScreenshot:async portion=>{if(portion==='uncertainty'&&!removed){removed=true;document.querySelector('[data-search-result-target]')!.remove();}return undefined;},onProgress:()=>{}});return {extracted,verification:api.verifyCapture(extracted)};});
  expect(result.verification.status).toBe('needs_review');expect(result.extracted.platformMetadata.visual_expansion_verification).toMatchObject([{transition_verified:true,verified:false,preserved:false}]);expect(result.extracted.loadResult.checks.find(c=>c.check_id==='content.not_truncated')?.status).toBe('fail');
 },20000);
 it('keeps a claimed expanded but still clipped body under review',async()=>{
  await page.setContent(modernClip().replace('aria-expanded="false"','aria-expanded="true"').replace('>Show more</button>','>Show less</button>'));const result=await capture();expect(result.verification.status).toBe('needs_review');expect(await page.evaluate(()=>(window as unknown as {__clipClicks?:number}).__clipClicks)).toBeUndefined();
 },20000);
 it('re-verifies a remounted native message rather than trusting an old node',async()=>{
  const fixture=modernClip();await page.setContent(fixture);const result=await page.evaluate(async fixture=>{let remounted=false;const api=globalThis.HhsCompleteness;const extracted=await new api.ChatGptAdapter().capture({document,sourceUrl:location.href,captureScreenshot:async portion=>{if(portion==='earliest_boundary'&&!remounted){remounted=true;document.querySelector('[aria-label="Conversation"]')!.innerHTML=new DOMParser().parseFromString(fixture,'text/html').querySelector('[aria-label="Conversation"]')!.innerHTML;}return undefined;},onProgress:()=>{}});return {extracted,verification:api.verifyCapture(extracted)};},fixture);
  expect(result.verification.status).toBe('complete');const proofs=result.extracted.platformMetadata.visual_expansion_verification as Array<{verified:boolean;preserved:boolean}>;expect(proofs.length).toBeGreaterThanOrEqual(2);expect(proofs.every(p=>p.verified&&p.preserved)).toBe(true);expect(result.extracted.platformMetadata.collapsed_messages_expanded).toBe(2);expect(result.extracted.messages.map(m=>m.platform_message_id)).toEqual(ids.slice(0,2));
 },35000);
 it('verifies an already expanded loaded body without clicking it',async()=>{
  await page.setContent(modernClip().replace('max-height:48px','max-height:none').replace('aria-expanded="false"','aria-expanded="true"').replace('>Show more</button>','>Show less</button>'));const result=await capture();
  expect(result.verification.status).toBe('complete');expect(result.extracted.platformMetadata.visual_expansion_verification).toMatchObject([{mode:'already_expanded',verified:true,preserved:true}]);expect(await page.evaluate(()=>(window as unknown as {__clipClicks?:number}).__clipClicks)).toBeUndefined();
 },20000);

 it('rejects body-level loading flags even when placeholder text is already present',async()=>{
  await page.setContent(modernClip().replace('data-search-result-target','data-state="loading" data-search-result-target'));const result=await capture();expect(result.verification.status).toBe('needs_review');expect(await page.evaluate(()=>(window as unknown as {__clipClicks?:number}).__clipClicks)).toBeUndefined();
 },20000);
 it('does not accept a contradictory Show less state',async()=>{
  await page.setContent(modernClip().replace('>Show more</button>','>Show less</button>'));const result=await capture();expect(result.verification.status).toBe('needs_review');expect(await page.evaluate(()=>(window as unknown as {__clipClicks?:number}).__clipClicks)).toBeUndefined();
 },20000);
 it('invalidates a successful proof if the same mounted control clips again',async()=>{
  await page.setContent(modernClip());const result=await page.evaluate(async()=>{const api=globalThis.HhsCompleteness;let regressed=false;const extracted=await new api.ChatGptAdapter().capture({document,sourceUrl:location.href,captureScreenshot:async portion=>{if(portion==='earliest_boundary'&&!regressed){regressed=true;document.querySelector<HTMLElement>('[data-search-result-target]')!.style.maxHeight='48px';document.querySelector('[data-user-message-bubble] button')!.setAttribute('aria-expanded','false');}return undefined;},onProgress:()=>{}});return {extracted,verification:api.verifyCapture(extracted)};});
  expect(result.verification.status).toBe('needs_review');expect(result.extracted.loadResult.checks.find(c=>c.check_id==='content.not_truncated')?.status).toBe('fail');
 },35000);

 it('does not click an unrelated control elsewhere in the user bubble',async()=>{
  await page.setContent(modernClip().replace('</p></div><button','</p></div><aside><button').replace('</button>','</button></aside>'));const result=await capture();expect(result.verification.status).toBe('needs_review');expect(await page.evaluate(()=>(window as unknown as {__clipClicks?:number}).__clipClicks)).toBeUndefined();
 },20000);
 it('supports the observed content-wrapper sibling relationship',async()=>{
  await page.setContent(modernClip().replace('<div data-search-result-target','<section><div data-search-result-target').replace('</p></div><button','</p></div></section><button').replace('this.previousElementSibling.style.maxHeight','this.previousElementSibling.firstElementChild.style.maxHeight'));const result=await capture();expect(result.verification.status).toBe('complete');expect(result.extracted.platformMetadata.visual_expansion_verification).toMatchObject([{verified:true,preserved:true}]);
 },20000);
 it('keeps existing legacy collapsed-message expansion working',async()=>{
  await page.setContent(html(pair().replace('<p>Synthetic original request.</p>','<div data-testid="collapsible-user-message-root" data-can-expand><p>Synthetic original request.</p><button onclick="this.remove()">Show more</button></div>')));const result=await capture();expect(result.verification.status).toBe('complete');expect(result.extracted.platformMetadata.collapsed_messages_expanded).toBe(1);
 },20000);
});
