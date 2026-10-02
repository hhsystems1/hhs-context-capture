import { ChatGptDiscoveryAdapter } from "@hhs/adapter-chatgpt/discovery";
import type { DiscoveryAdapter } from "@hhs/discovery-engine/adapter-contract";

/**
 * The only place in the extension that knows which sources exist. Adding a source is one entry here
 * plus its adapter, and — because a content script cannot run on a host the manifest does not grant —
 * a matching `host_permissions` change that is reviewed on its own.
 */
export interface DiscoveryRegistration {
  id: string;
  sourceKind: string;
  hostPattern: RegExp;
  hosts: string[];
  create(): DiscoveryAdapter;
}

export const DISCOVERY_REGISTRY: readonly DiscoveryRegistration[] = [
  {
    id: "chatgpt-sidebar-discovery",
    sourceKind: "chatgpt",
    hostPattern: /^(chatgpt\.com|chat\.openai\.com)$/,
    hosts: ["chatgpt.com", "chat.openai.com"],
    create: () => new ChatGptDiscoveryAdapter()
  }
];

export interface SupportedResolution {
  supported: true;
  registration: DiscoveryRegistration;
  adapter: DiscoveryAdapter;
}

export interface UnsupportedResolution {
  supported: false;
  host: string;
  reason: "no_adapter_registered";
  registered_hosts: string[];
}

export type AdapterResolution = SupportedResolution | UnsupportedResolution;

export function registeredDiscoveryHosts(): string[] {
  return DISCOVERY_REGISTRY.flatMap((registration) => registration.hosts);
}

/**
 * Resolves a host to an adapter. An unsupported host returns an explicit typed refusal rather than
 * an empty result, so "this site has no adapter" can never be mistaken for "this site is empty".
 */
export function resolveDiscoveryAdapter(host: string): AdapterResolution {
  const registration = DISCOVERY_REGISTRY.find((candidate) => candidate.hostPattern.test(host));
  if (!registration) {
    return { supported: false, host, reason: "no_adapter_registered", registered_hosts: registeredDiscoveryHosts() };
  }
  return { supported: true, registration, adapter: registration.create() };
}
