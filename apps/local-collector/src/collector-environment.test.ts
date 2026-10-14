import { describe, it, expect } from "vitest";
import { collectorEnvironment } from "./collector-environment.js";
const configured = { MEMORY_WORKSPACE_ID: "registered-history", MEMORY_INGEST_DATABASE_URL: "postgresql://memory_v1_ingest_login:synthetic@127.0.0.1:55022/postgres",
  MEMORY_REPORT_DATABASE_URL: "postgresql://memory_v1_report_login:synthetic@127.0.0.1:55022/postgres" };
describe("registered collector environment", () => {
  it("preserves runtime settings while overriding old scope and removing unrelated credentials", () => {
    const env = collectorEnvironment({ PATH: "/runtime", MEMORY_WORKSPACE_ID: "old", MEMORY_DATABASE_URL: "admin", MEMORY_REVIEW_DATABASE_URL: "reviewer", OPENROUTER_API_KEY: "model-key" }, configured);
    expect(env.MEMORY_WORKSPACE_ID).toBe("registered-history"); expect(env.PATH).toBe("/runtime");
    for (const key of ["MEMORY_DATABASE_URL", "MEMORY_REVIEW_DATABASE_URL", "OPENROUTER_API_KEY"]) expect(env[key]).toBeUndefined();
  });
  it("refuses privileged, external or unexpected configuration", () => {
    for (const override of [{ MEMORY_INGEST_DATABASE_URL: "postgresql://postgres:synthetic@127.0.0.1:55022/postgres" }, { MEMORY_REPORT_DATABASE_URL: "postgresql://memory_v1_report_login:synthetic@external.example/db" }, { MEMORY_DATABASE_URL: "admin" }]) expect(() => collectorEnvironment({}, { ...configured, ...override })).toThrow();
  });
});
