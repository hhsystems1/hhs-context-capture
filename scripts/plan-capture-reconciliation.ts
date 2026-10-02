import { readFile } from "node:fs/promises";
import path from "node:path";
import { scanCaptureArchiveReadOnly } from "@hhs/capture-versioning/archive-reconciler";
import { planCaptureReconciliation } from "@hhs/capture-versioning";
import type { CatalogState } from "@hhs/conversation-catalog";

const options = parseArguments(process.argv.slice(2));
const catalog = JSON.parse(await readFile(path.join(options.catalogRoot, "catalog.json"), "utf8")) as CatalogState;
const existing = Object.values(catalog.conversations).filter((item) => item.platform_id === options.platformId && item.opaque_account_reference === options.accountReference).flatMap((item) => item.capture_versions);
const scan = await scanCaptureArchiveReadOnly(options.captureRoot, { platform_id: options.platformId, opaque_account_reference: options.accountReference });
const decisions = planCaptureReconciliation(existing, scan.candidates);
console.log(JSON.stringify({ mode: "read_only_plan", candidates: scan.candidates.length, decisions, warnings: scan.warnings }, null, 2));

function parseArguments(args: string[]) {
  const value = (name: string) => {
    const index = args.indexOf(name);
    const result = index >= 0 ? args[index + 1] : undefined;
    if (!result) throw new Error(`Missing required argument ${name}.`);
    return path.resolve(result);
  };
  const text = (name: string) => {
    const index = args.indexOf(name);
    const result = index >= 0 ? args[index + 1] : undefined;
    if (!result) throw new Error(`Missing required argument ${name}.`);
    return result;
  };
  return { captureRoot: value("--capture-root"), catalogRoot: value("--catalog-root"), platformId: text("--platform"), accountReference: text("--account-reference") };
}
