import { describe, expect, it, vi } from "vitest";
import {
  assessApplicationListeners, assessPublishedBindings, isLoopbackAddress, runFailClosed,
  sanitizeSensitiveOutput, shouldStartManaged, type DockerPortBinding, type WindowsListener
} from "./local-security.js";
import { forceLoopbackPortBindings } from "./docker-loopback-proxy.js";

const binding = (hostAddress: string, hostPort = 55021): DockerPortBinding => ({
  container: "synthetic-supabase", containerPort: 8000, hostAddress, hostPort
});
const listener = (localAddress: string, localPort = 55021): WindowsListener => ({
  localAddress, localPort, owningProcess: 100
});

describe("Windows local-only binding enforcement", () => {
  it("accepts explicit IPv4 and IPv6 loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("[::1]")).toBe(true);
  });

  it("rejects IPv4 wildcard, unspecified, LAN, and IPv6 wildcard addresses", () => {
    for (const address of ["", "0.0.0.0", "::", "[::]", "192.168.1.10"]) expect(isLoopbackAddress(address)).toBe(false);
  });

  it("requires both Docker and Windows listener evidence for every Supabase port", () => {
    const ports = [55021, 55022, 55023];
    const bindings = ports.map((port) => binding("127.0.0.1", port));
    const listeners = ports.map((port) => listener("127.0.0.1", port));
    expect(assessPublishedBindings(bindings, listeners, ports).safe).toBe(true);
    expect(assessPublishedBindings([...bindings, binding("0.0.0.0")], listeners, ports).safe).toBe(false);
    expect(assessPublishedBindings(bindings, [...listeners, listener("::")], ports).safe).toBe(false);
  });

  it("rejects wildcard application listeners", () => {
    expect(assessApplicationListeners([listener("127.0.0.1", 43117), listener("127.0.0.1", 43118)], [43117, 43118]).safe).toBe(true);
    expect(assessApplicationListeners([listener("0.0.0.0", 43117), listener("::", 43118)], [43117, 43118]).safe).toBe(false);
  });

  it("redacts database URLs, passwords, API secrets, JWTs, pairing codes, and nonlocal URLs", () => {
    const unsafe = "DB postgresql://user:pass@127.0.0.1:55022/db password=secret api_key=secret pairing code=abcd1234 " +
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.signature https://192.168.1.9:55021";
    const safe = sanitizeSensitiveOutput(unsafe);
    expect(safe).not.toContain("user:pass");
    expect(safe).not.toContain("password=secret");
    expect(safe).not.toContain("api_key=secret");
    expect(safe).not.toContain("abcd1234");
    expect(safe).not.toContain("192.168.1.9");
  });

  it("rolls startup back when binding verification fails", async () => {
    const rollback = vi.fn(async () => undefined);
    await expect(runFailClosed(async () => "started", async () => false, rollback)).rejects.toThrow("verification failed");
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("prevents duplicate managed process starts when a listener already exists", () => {
    expect(shouldStartManaged(false)).toBe(true);
    expect(shouldStartManaged(true)).toBe(false);
  });

  it("forces every Docker create port binding to explicit IPv4 loopback", () => {
    const request = {
      HostConfig: {
        PortBindings: {
          "8000/tcp": [{ HostIp: "", HostPort: "55021" }],
          "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "55022" }, { HostIp: "::", HostPort: "55022" }]
        }
      }
    };
    forceLoopbackPortBindings(request);
    expect(request.HostConfig.PortBindings["8000/tcp"][0]?.HostIp).toBe("127.0.0.1");
    expect(request.HostConfig.PortBindings["5432/tcp"].every((row) => row.HostIp === "127.0.0.1")).toBe(true);
  });
});
