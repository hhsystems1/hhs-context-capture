import {afterEach,describe,expect,it,vi} from 'vitest';


afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();delete (globalThis as {__hhsContextCaptureRegistered?:boolean}).__hhsContextCaptureRegistered;});
describe('capture diagnostic handoff without any real capture',()=>{
 it('retains a page-detection failure safely instead of discarding its stage',async()=>{
  vi.resetModules();const {ChatGptAdapter}=await import('@hhs/adapter-chatgpt');let listener:((message:unknown,sender:unknown,sendResponse:(body:unknown)=>void)=>boolean)|undefined;
  vi.stubGlobal('chrome',{runtime:{onMessage:{addListener:(fn:typeof listener)=>{listener=fn;}},sendMessage:vi.fn(async()=>({ok:true,body:{}}))}});
  vi.stubGlobal('document',{});vi.stubGlobal('location',{href:'https://chatgpt.com/c/synthetic',hostname:'chatgpt.com'});
  vi.spyOn(ChatGptAdapter.prototype,'detect').mockResolvedValue({detected:false,platform:'chatgpt',confidence:'low',reasons:['Synthetic not-ready fixture.']});
  await import('./content.js');const sendResponse=vi.fn();
  expect(listener?.({type:'HHS_CAPTURE_CURRENT',operation:{operationId:'operation_synthetic',correlationId:'correlation_synthetic',eventSequence:5,expectedConversationReference:'conversation_synthetic'}},{},sendResponse)).toBe(true);
  await vi.waitFor(()=>expect(sendResponse).toHaveBeenCalled());
  const result=sendResponse.mock.calls[0]?.[0];expect(result).toMatchObject({ok:false,diagnostic:{stage:'page_detection',reason_code:'conversation_not_rendered'}});
  expect(JSON.stringify(result)).not.toContain('Synthetic not-ready fixture');
 });
});


it('preserves collector HTTP status through the real worker without leaking a rejected response body',async()=>{
 vi.resetModules();let listener:((message:unknown,sender:unknown,response:(body:unknown)=>void)=>boolean)|undefined;
 vi.stubGlobal('chrome',{runtime:{onMessage:{addListener:(fn:typeof listener)=>{listener=fn;}},onConnect:{addListener:vi.fn()}},storage:{local:{get:vi.fn(async()=>({collectorToken:'synthetic_test_token'}))}}});
 const fetch=vi.fn(async()=>Response.json({error:'PRIVATE conversation <html> Bearer synthetic_password',details:'C:\\private\\archive'},{status:413}));vi.stubGlobal('fetch',fetch);
 await import('./background.js');const sendResponse=vi.fn();listener?.({type:'HHS_COLLECTOR_REQUEST',endpoint:'operations/synthetic/events',body:{synthetic:true}},{},sendResponse);
 await vi.waitFor(()=>expect(sendResponse).toHaveBeenCalled());const result=sendResponse.mock.calls[0]?.[0];
 expect(result).toMatchObject({ok:false,diagnostic:{stage:'operation_event',reason_code:'http_413',safe_error_code:'validation_failed'}});
 expect(JSON.stringify(result)).not.toMatch(/PRIVATE|synthetic_password|private\\\\archive/);expect(fetch).toHaveBeenCalledTimes(1);
});


it('records the received safe stage/reason at the popup without overwriting last successful stage',async()=>{
 vi.resetModules();const {captureFailure}=await import('@hhs/capture-operations');
 const buttons=new Map<string,{disabled:boolean;dataset:Record<string,string>;textContent:string;value:string;addEventListener:ReturnType<typeof vi.fn>}>();
 const listeners=new Map<string,()=>Promise<void>>();
 vi.stubGlobal('document',{querySelector:(selector:string)=>{
  if(!buttons.has(selector))buttons.set(selector,{disabled:true,dataset:{},textContent:'',value:'',addEventListener:vi.fn((event:string,fn:()=>Promise<void>)=>listeners.set(selector+':'+event,fn))});
  return buttons.get(selector);
 }});
 const storage={get:vi.fn(async()=>({collectorToken:'synthetic_token',captureOperationRecent:[]})),set:vi.fn()};
 const diagnostic=captureFailure('page_detection','conversation_not_rendered').diagnostic;
 vi.stubGlobal('chrome',{storage:{local:storage},runtime:{onMessage:{addListener:vi.fn()}},tabs:{query:vi.fn(async()=>[{id:77,url:'https://chatgpt.com/c/synthetic'}]),sendMessage:vi.fn(async(_id:number,message:{type:string})=>message.type==='HHS_OBSERVE_CAPTURE_IDENTITY'?{ok:true,identity:{platform:'chatgpt',opaqueAccountReference:'account_synthetic',opaqueConversationReference:'conversation_synthetic'}}:{ok:false,diagnostic,error:'PRIVATE conversation discarded'})}});
 const events:Array<Record<string,unknown>>=[];let operationId='',correlationId='';
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:{method?:string;body?:string})=>{
  if(url.endsWith('/operations/latest'))return Response.json({operation:null});
  if(url.endsWith('/operations')&&init?.method==='POST'){const b=JSON.parse(init.body??'{}');operationId=b.operation_id;correlationId=b.correlation_id;return Response.json({operation_id:operationId,correlation_id:correlationId,last_event_sequence:1});}
  if(url.endsWith('/events')){events.push(JSON.parse(init?.body??'{}'));return Response.json({});}
  const failed=events.some(e=>e.event_type==='capture_failed');return Response.json({operation:{operation_id:operationId,correlation_id:correlationId,status:failed?'failed':'capturing',last_event_sequence:failed?6:5,last_event_type:failed?'capture_failed':'capture_started',last_successful_stage:'capture_started',last_event_at:'2026-10-17T00:00:00Z',safe_capture_reference:null,stop_summary:null}});
 }));
 await import('./popup.js');await vi.waitFor(()=>expect(buttons.get('#capture')?.disabled).toBe(false));
 await listeners.get('#capture:click')?.();
 const failure=events.find(e=>e.event_type==='capture_failed');expect(failure).toMatchObject({event_sequence:6,metadata:{stage:'page_detection',reason_code:'conversation_not_rendered',last_successful_stage:'capture_started'}});
 expect(JSON.stringify(events)).not.toMatch(/PRIVATE|discarded/);
 expect(buttons.get('#status')?.textContent).toMatch(/page_detection.*conversation_not_rendered/);
});
