import manifest from '../manifest.json' with {type:'json'};
import {resolveDiscoveryAdapter} from './discovery/registry.js';

export interface CaptureRuntime {
 protocol:1; bundle_version:string; manifest_version:string; extension_id:string;
 adapter_id:string; adapter_version:string; instance_id:string;
}
export const CAPTURE_BUNDLE_VERSION=manifest.version;
export function expectedCaptureRuntime(host:string,extensionId:string) {
 const resolution=resolveDiscoveryAdapter(host);
 if(!resolution.supported||!resolution.registration.capture)throw Error('No capture runtime for this host.');
 return {protocol:1 as const,bundle_version:CAPTURE_BUNDLE_VERSION,extension_id:extensionId,
  adapter_id:resolution.registration.capture.id,adapter_version:resolution.registration.capture.create().adapterVersion};
}
/** Reads the actual listener's bundled adapter; never reads transcript, storage or credentials. */
export function inspectCaptureRuntime(host:string,instanceId:string):CaptureRuntime {
 return {...expectedCaptureRuntime(host,chrome.runtime.id),manifest_version:chrome.runtime.getManifest().version,instance_id:instanceId};
}
export function parseCaptureRuntime(value:unknown):CaptureRuntime|undefined {
 if(typeof value!=='object'||value===null)return undefined;
 const actual=value as Partial<CaptureRuntime>;
 const keys=['protocol','bundle_version','manifest_version','extension_id','adapter_id','adapter_version','instance_id'];
 if(Object.keys(value).sort().join(',')!==keys.sort().join(','))return undefined;
 if(actual.protocol!==1||![actual.bundle_version,actual.manifest_version,actual.adapter_version].every(v=>typeof v==='string'&&/^\d+\.\d+\.\d+$/.test(v)))return undefined;
 if(typeof actual.extension_id!=='string'||!/^[a-p]{32}$/.test(actual.extension_id)||typeof actual.adapter_id!=='string'||!/^[a-z0-9-]{1,80}$/.test(actual.adapter_id))return undefined;
 if(typeof actual.instance_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(actual.instance_id))return undefined;
 return actual as CaptureRuntime;
}
export function runtimeMatches(value:unknown,expected:ReturnType<typeof expectedCaptureRuntime>):value is CaptureRuntime {
 const actual=parseCaptureRuntime(value);
 return Boolean(actual)&&Object.entries(expected).every(([key,item])=>actual![key as keyof CaptureRuntime]===item)
  && actual!.manifest_version===expected.bundle_version;
}
export function sameCaptureRuntime(value:unknown,actual:CaptureRuntime):boolean {
 return runtimeMatches(value,actual)&&(value as CaptureRuntime).instance_id===actual.instance_id;
}
