import {afterEach,describe,expect,it,vi} from 'vitest';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
async function popup(options:{host?:string;ready?:boolean;pairingValid?:boolean;captureGate?:Promise<void>}={}){
 vi.resetModules();const elements=new Map<string,{disabled:boolean;dataset:Record<string,string>;textContent:string;hidden:boolean;value:string;addEventListener:(event:string,listener:()=>Promise<void>)=>void}>();
 const listeners=new Map<string,()=>Promise<void>>();
 vi.stubGlobal('document',{querySelector:(selector:string)=>{if(!elements.has(selector))elements.set(selector,{disabled:true,dataset:{},textContent:'',hidden:false,value:'',addEventListener:(event,listener)=>listeners.set(selector+':'+event,listener)});return elements.get(selector);}});
 let ready=options.ready??true;const host=options.host??'chatgpt.com';
 const storage={get:vi.fn(async()=>({collectorToken:'synthetic-local-token',captureOperationRecent:[]})),set:vi.fn()};
 const execute=vi.fn(async(details:{func?:{name:string}})=>[{result:details.func?.name==='inspectRenderedPage'?{host,conversation_path:true,kind:'conversation_candidate'}:{ready,messages:2,loading:false,issues:ready?[]:['ambiguous_authorship']}}]);
 const send=vi.fn(async(_tab:number,message:{type:string})=>{if(message.type==='HHS_CAPTURE_CURRENT')await options.captureGate;return message.type==='HHS_OBSERVE_CAPTURE_IDENTITY'?{ok:true,identity:{platform:'chatgpt',opaqueAccountReference:'synthetic-account',opaqueConversationReference:'synthetic-conversation'}}:{ok:false,diagnostic:{stage:'page_detection',reason_code:'conversation_not_rendered',safe_error_code:'internal_error',safe_error_summary:'A local component reported a safe internal failure.'}};});
 vi.stubGlobal('chrome',{scripting:{executeScript:execute},storage:{local:storage},runtime:{onMessage:{addListener:vi.fn()}},tabs:{query:vi.fn(async()=>[{id:71,url:'https://'+host+'/c/synthetic'}]),sendMessage:send}});
 const requests:Array<{url:string;method:string}>=[];
 const fetch=vi.fn(async(url:string,init?:{method?:string;body?:string})=>{
  requests.push({url,method:init?.method??'GET'});
  if(url.endsWith('/operations/latest'))return Response.json(options.pairingValid===false?{error:'pairing_required'}:{operation:null},{status:options.pairingValid===false?401:200});
  if(url.endsWith('/operations')&&init?.method==='POST'){const body=JSON.parse(init.body??'{}');return Response.json({...body,last_event_sequence:1});}
  if(url.endsWith('/events'))return Response.json({});
  return Response.json({operation:{status:'failed',last_successful_stage:'capture_started'}});
 });vi.stubGlobal('fetch',fetch);await import('./popup.js');
 await vi.waitFor(()=>{expect(execute.mock.calls.length).toBeGreaterThan(0);expect(fetch).toHaveBeenCalled();expect(elements.get('#page-status')?.textContent).not.toBe('');});
 return {elements,listeners,requests,send,storage,execute,setReady:(value:boolean)=>{ready=value;}};
}
describe('discovery-first popup remains read-only until explicit ready capture',()=>{
 it('opening a recognized page inspects without invoking capture, storage writes or collector POSTs',async()=>{const state=await popup();await vi.waitFor(()=>expect(state.elements.get('#capture')?.disabled).toBe(false));expect(state.send).not.toHaveBeenCalled();expect(state.storage.set).not.toHaveBeenCalled();expect(state.requests.every(request=>request.method==='GET')).toBe(true);});
 it('unsupported websites never acquire a capture adapter or create an operation',async()=>{const state=await popup({host:'example.test'});expect(state.elements.get('#capture')?.disabled).toBe(true);await state.listeners.get('#capture:click')?.();expect(state.send).not.toHaveBeenCalled();expect(state.requests.every(request=>request.method==='GET')).toBe(true);});
 it('rechecks the page before capture and refuses newly ambiguous authorship',async()=>{const state=await popup();await vi.waitFor(()=>expect(state.elements.get('#capture')?.disabled).toBe(false));state.setReady(false);await state.listeners.get('#capture:click')?.();expect(state.send).not.toHaveBeenCalled();expect(state.requests.every(request=>request.method==='GET')).toBe(true);expect(state.elements.get('#capture')?.disabled).toBe(true);});
 it('a valid structural probe cannot override invalid collector pairing',async()=>{const state=await popup({pairingValid:false});await vi.waitFor(()=>expect(state.elements.get('#status')?.textContent).toContain('no longer valid'));expect(state.elements.get('#capture')?.disabled).toBe(true);expect(state.requests.every(request=>request.method==='GET')).toBe(true);});
 it('does not enable a second capture while the first explicit request is in flight',async()=>{const state=await popup();await vi.waitFor(()=>expect(state.elements.get('#capture')?.disabled).toBe(false));const first=state.listeners.get('#capture:click')?.();const second=state.listeners.get('#capture:click')?.();await Promise.all([first,second]);expect(state.requests.filter(request=>request.method==='POST'&&request.url.endsWith('/operations'))).toHaveLength(1);expect(state.send.mock.calls.filter(call=>call[1].type==='HHS_CAPTURE_CURRENT')).toHaveLength(1);});
 it('keeps discovery excluded while an explicit capture owns the popup',async()=>{let release!:()=>void;const captureGate=new Promise<void>(resolve=>{release=resolve;});const state=await popup({captureGate});await vi.waitFor(()=>expect(state.elements.get('#capture')?.disabled).toBe(false));const first=state.listeners.get('#capture:click')?.();try{await vi.waitFor(()=>expect(state.send.mock.calls.some(call=>call[1].type==='HHS_CAPTURE_CURRENT')).toBe(true));expect(state.elements.get('#discover')?.disabled).toBe(true);await state.listeners.get('#discover:click')?.();expect(state.send.mock.calls.some(call=>call[1].type==='HHS_DISCOVER_SITE')).toBe(false);expect(state.elements.get('#capture')?.disabled).toBe(true);}finally{release();await first;}});

});
