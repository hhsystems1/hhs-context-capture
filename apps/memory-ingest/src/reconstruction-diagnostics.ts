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
export function quarantineDetails(root: string, workspace: string, quarantined: unknown[]) {
  return quarantined.slice(0, 10).map(value => {
    const item = value as Record<string, unknown>;
    const id = String(item.source_conversation_id ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error("Invalid quarantine source identity.");
    let diagnostic = { code: "reconstruction_failed", issue_count: 0,
      summary: "Processing stopped. Preserved attempts need operator review before retrying." };
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
