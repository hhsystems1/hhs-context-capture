import { describe, expect, it, vi } from "vitest";
import { parsePromotionArguments, parseReconciliationArguments, runPromotionCommand, runReconciliationCommand } from "./reconciliation-commands.js";
import { createPool } from "./db.js";

vi.mock("./db.js", () => ({ createPool: vi.fn(), transaction: vi.fn(), readOnlyTransaction: vi.fn() }));
const flags = ["--source-workspace", "source", "--reconciliation-id", "persisted", "--destination-workspace", "destination", "--brain-type", "project", "--target-ref", "Project"];

describe("operator reconciliation commands", () => {
  it.each(["source-workspace", "reconciliation-id", "destination-workspace", "brain-type", "target-ref"])("rejects missing and blank --%s before connecting", async (name) => {
    const index = flags.indexOf(`--${name}`);
    const missing = [...flags]; missing.splice(index, 2);
    const blank = [...flags]; blank[index + 1] = " ";
    for (const args of [missing, blank]) await expect(runPromotionCommand(args)).rejects.toThrow(`--${name} is required`);
    expect(createPool).not.toHaveBeenCalled();
  });
  it("uses only explicit destination arguments", () => {
    expect(parsePromotionArguments(flags)).toEqual({ sourceWorkspaceId: "source", reconciliationId: "persisted", destinationWorkspaceId: "destination", destination: { brain_type: "project", target_ref: "Project" } });
    expect(() => parsePromotionArguments(flags.map((arg) => arg === "project" ? "global" : arg))).toThrow(/brain-type/);
  });
  it("requires operator-selected observation identities again on persistence", async () => {
    await expect(runReconciliationCommand(["persist", "--output", "model.json"], "source")).rejects.toThrow(/observations/);
    expect(createPool).not.toHaveBeenCalled();
    expect(parseReconciliationArguments(["persist", "--observations", "o1,o2", "--output", "model.json"], "source")).toMatchObject({ observationIds: ["o1", "o2"], workspaceId: "source" });
  });
});
