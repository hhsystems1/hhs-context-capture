import { describe, expect, it } from "vitest";
import { DISCOVERY_REGISTRY, registeredDiscoveryHosts, resolveDiscoveryAdapter } from "./registry.js";

describe("discovery adapter registry", () => {
  it("resolves the ChatGPT adapter for its own hosts", () => {
    for (const host of ["chatgpt.com", "chat.openai.com"]) {
      const resolution = resolveDiscoveryAdapter(host);
      expect(resolution.supported).toBe(true);
      if (!resolution.supported) return;
      expect(resolution.adapter.sourceKind).toBe("chatgpt");
      expect(resolution.adapter.adapterId).toBe("chatgpt-sidebar-discovery");
      expect(resolution.adapter.transport).toBe("browser_dom");
    }
  });

  it("returns a typed refusal for an unsupported host instead of an empty result", () => {
    const resolution = resolveDiscoveryAdapter("notebooklm.google.com");

    expect(resolution.supported).toBe(false);
    if (resolution.supported) return;
    expect(resolution.reason).toBe("no_adapter_registered");
    expect(resolution.host).toBe("notebooklm.google.com");
    expect(resolution.registered_hosts).toContain("chatgpt.com");
  });

  it("refuses look-alike hosts", () => {
    for (const host of ["chatgpt.com.evil.example", "evil-chatgpt.com", "openai.com"]) {
      expect(resolveDiscoveryAdapter(host).supported).toBe(false);
    }
  });

  it("registers only ChatGPT in this version", () => {
    // Guards against a source being added without its own review.
    expect(DISCOVERY_REGISTRY).toHaveLength(1);
    expect(registeredDiscoveryHosts().sort()).toEqual(["chat.openai.com", "chatgpt.com"]);
  });
});
