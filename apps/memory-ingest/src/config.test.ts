import { describe, expect, it } from "vitest";
import { assertLocalDatabaseUrl } from "./config.js";

describe("Memory V1.1 private local configuration", () => {
  it("accepts only loopback PostgreSQL URLs", () => {
    expect(assertLocalDatabaseUrl("postgresql://local:local@127.0.0.1:5432/postgres").hostname).toBe("127.0.0.1");
    expect(() => assertLocalDatabaseUrl("postgresql://user:secret@db.example.invalid/postgres")).toThrow(/Hosted database/);
  });
});
