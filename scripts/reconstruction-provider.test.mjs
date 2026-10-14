import { describe, it, expect } from "vitest";
import { providerRequestSignal } from "./reconstruction-provider.mjs";
import { setTimeout, clearTimeout } from "node:timers";

describe("bounded reconstruction requests", () => {
  it("aborts a stalled provider and rejects invalid timeout configuration", async () => {
    const signal = providerRequestSignal({ HHS_RECONSTRUCTION_REQUEST_TIMEOUT_MS: "1000" });
    await expect(new Promise((resolve, reject) => {
      const keepAlive = setTimeout(resolve, 5000);
      signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(signal.reason); });
    })).rejects.toMatchObject({ name: "TimeoutError" });
    for (const value of ["0", "-1", "900001", "abc"]) expect(() => providerRequestSignal({ HHS_RECONSTRUCTION_REQUEST_TIMEOUT_MS: value })).toThrow();
  });
});
