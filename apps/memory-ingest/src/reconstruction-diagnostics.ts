import fs from "node:fs";
import path from "node:path";
import { validateDiscoveryOutput } from "./understanding-discovery.js";

export function validationSummary(issues: Array<{ problem: string }>) {
  const unknown = issues.filter(issue => /unknown evidence_ref|evidence_ref.*(does not exist|unknown|not found)/i.test(issue.problem)).length;
  const authority = issues.filter(issue => /user.*(authored|authority|evidence)/i.test(issue.problem)).length;
  return { code: unknown ? "unknown_evidence_reference" : authority ? "unsupported_user_authority" : "validation_failed",
    issue_count: issues.length,
    summary: unknown ? `${unknown} model citation(s) referenced evidence absent from the trusted source. Nothing was persisted.`
      : authority ? "Model output claimed user authority without supporting user evidence. Nothing was persisted."
      : "Model output failed trusted validation. Its source and failed attempts were preserved." };
}

// Read old attempts as well as new diagnostics; terminal batch receipts stay intact.
export function quarantineDetails(root: string, workspace: string, quarantined: unknown[], operation?: string) {
  return quarantined.slice(0, 10).map(value => {
    const item = value as Record<string, unknown>;
    const id = String(item.source_conversation_id ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error("Invalid quarantine source identity.");
    let diagnostic = { code: "reconstruction_failed", issue_count: 0,
      summary: "Processing stopped. Preserved attempts need operator review before retrying." };
    const specific: Record<string, { code: string; issue_count: number; summary: string }> = {
      model_output_truncated: { code: "model_output_truncated", issue_count: 0, summary: "Oversized source: model response exceeded its output limit. Evidence-preserving subdivision could not finish; attempts are preserved for review." },
      malformed_model_json: { code: "malformed_model_json", issue_count: 0, summary: "Model returned malformed JSON. No incomplete output was saved; failed attempts are preserved." },
      request_timeout: { code: "request_timeout", issue_count: 0, summary: "Model request timed out. Completed chunks and failed attempts remain available for resume." },
      source_deadline: { code: "source_deadline", issue_count: 0, summary: "Source processing reached its bounded deadline. Completed chunks remain available for resume." },
      evidence_validation: { code: "validation_failed", issue_count: 0, summary: "Model output failed trusted evidence validation. Original evidence and rejected attempts are preserved." }
    };
    const code = item.failure_code ?? preservedFailureCode(root, workspace, id, operation);
    if (typeof code === "string" && Object.hasOwn(specific, code)) {
      return { source_conversation_id: id, title: String(item.title ?? "Historical conversation").slice(0, 160), ...specific[code]! };
    }
    // A cached, older standard validation error cannot explain a current
    // provider/chunk/linker failure. Only inspect it for a validation outcome.
    if (!/standard validation failed|trusted validation|exited with status 10\b/i.test(String(item.reason ?? ""))) {
      return { source_conversation_id: id, title: String(item.title ?? "Historical conversation").slice(0, 160), ...diagnostic };
    }
    const failed = path.join(root, ".runtime/reconstruction/priority-runs/failed-attempts");
    try {
      const bases = fs.readdirSync(failed).filter(name => /^priority-\d+-/.test(name) && name.endsWith(`-${id}`));
      const attempts = bases.flatMap(base => fs.readdirSync(path.join(failed, base)).map(name => path.join(failed, base, name))).sort().reverse();
      for (const directory of attempts.slice(0, 3)) {
        const meta = JSON.parse(fs.readFileSync(path.join(directory, "attempt.json"), "utf8"));
        if (meta.workspace !== workspace) continue;
        const names = fs.readdirSync(directory);
        const input = names.find(name => name.endsWith("-input.json"));
        const output = names.find(name => name.endsWith("-output.json"));
        const raw = names.find(name => name.endsWith("-openrouter-raw.json"));
        if (!input || !output || !raw) continue;
        const exchange = JSON.parse(fs.readFileSync(path.join(directory, input), "utf8"));
        if (exchange.selection?.length !== 1 || exchange.selection[0].source_conversation_id !== id) continue;
        const model = JSON.parse(fs.readFileSync(path.join(directory, raw), "utf8")).model;
        const result = validateDiscoveryOutput(exchange, JSON.parse(fs.readFileSync(path.join(directory, output), "utf8")),
          { provider: "openrouter", name: model, runner_version: "hhs-priority-nemotron-runner/0.1.0" });
        if (result.issues.length) { diagnostic = validationSummary(result.issues); break; }
      }
    } catch { /* A missing/incomplete diagnostic must not expose private exceptions. */ }
    return { source_conversation_id: id, title: String(item.title ?? "Historical conversation").slice(0, 160), ...diagnostic };
  });
}

function preservedFailureCode(root: string, workspace: string, source: string, operation?: string): unknown {
  if (!operation || !/^operation_[0-9a-f]{32}$/.test(operation)) return undefined;
  try {
    const directory = path.join(root, ".runtime/reconstruction/oversized-runs");
    const names = fs.readdirSync(directory).filter(name => /^priority-\d+-/.test(name) && name.endsWith("-" + source)).slice(-2);
    for (const name of names) {
      const file = path.join(directory, name, "failure-" + operation + ".json");
      if (!fs.existsSync(file)) continue;
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value.workspace === workspace && value.operation_id === operation && value.source_conversation_id === source) return value.failure_code;
    }
  } catch { /* Missing diagnostics stay generic; never expose private exceptions. */ }
  return undefined;
}
