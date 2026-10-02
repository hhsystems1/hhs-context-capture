import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { collectDiagnostics } from "../apps/mission-control/src/diagnostics.js";
import { startDockerLoopbackProxy } from "../apps/mission-control/src/docker-loopback-proxy.js";
import {
  assessApplicationListeners, HHS_LOOPBACK_NETWORK, inspectDockerBindings, inspectWindowsListeners,
  shouldStartManaged, SUPABASE_HOST_PORTS, verifySupabaseLoopback
} from "../apps/mission-control/src/local-security.js";
import { MissionControlStore } from "../apps/mission-control/src/store.js";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const RUNTIME = path.join(ROOT, ".runtime");
const STATE_FILE = path.join(RUNTIME, "hhs-processes.json");
const command = process.argv[2] ?? "status";

if (command === "status") await status();
else if (command === "up") await up();
else if (command === "down") await down();
else throw new Error("Usage: hhs.ts <up|status|down>");

async function status(): Promise<void> {
  const diagnostics = await collectDiagnostics(ROOT);
  let report: Record<string, unknown> | undefined;
  let databaseState: "ready" | "degraded";
  try {
    const store = new MissionControlStore(required("MEMORY_WORKSPACE_ID"), required("MEMORY_REPORT_DATABASE_URL"));
    try { report = await store.snapshot(); databaseState = "ready"; } finally { await store.close(); }
  } catch { databaseState = "degraded"; }
  const memory = report?.memory as Record<string, number> | undefined;
  const operations = report?.operations as Array<Record<string, unknown>> | undefined;
  const latest = operations?.[0];
  const system = [
    ["Docker", diagnostics.docker],
    ["Supabase", diagnostics.supabase],
    ["Bind addresses", diagnostics.bindings],
    ["Migrations", diagnostics.migrations],
    ["Collector", diagnostics.collector],
    ["Extension", diagnostics.extension],
    ["Git", diagnostics.git],
    ["Publication", diagnostics.publication],
    ["Reporting database", { state: databaseState, detail: databaseState === "ready" ? "Read-only report available" : "Read-only report unavailable" }]
  ] as const;
  console.log("HHS LOCAL STATUS");
  console.log("================");
  for (const [name, item] of system) console.log(`${mark(item.state)} ${name}: ${item.detail}`);
  console.log("");
  console.log(`Latest operation: ${latest ? `${latest.operation_ref} · ${latest.status} · ${latest.last_successful_stage}` : "none"}`);
  console.log(`Needs You: ${Number(report?.needs_you ?? 0)}`);
  console.log(`Memory: ${Number(memory?.messages ?? 0)} messages · ${Number(memory?.blocks ?? 0)} blocks · ${Number(memory?.proposed ?? 0)} proposed · ${Number(memory?.approved ?? 0)} approved`);
}

async function up(): Promise<void> {
  await mkdir(RUNTIME, { recursive: true });
  const state = await readState();
  const managed: Record<string, unknown> = { ...state, updated_at: new Date().toISOString() };
  try {
    await ensureLoopbackNetwork();
    if (!(await listening(55021))) await runSupabase("start");
    const supabaseSecurity = await verifySupabaseLoopback();
    if (!supabaseSecurity.assessment.safe) throw new Error("Supabase binding verification failed.");
    if (shouldStartManaged(await listening(port("HHS_COLLECTOR_PORT", 43117)))) {
      managed.collector = startManaged("apps/local-collector/src/server.ts");
    }
    if (shouldStartManaged(await listening(port("HHS_MISSION_CONTROL_PORT", 43118)))) {
      managed.mission_control = startManaged("apps/mission-control/src/server.ts");
    }
    await waitFor(port("HHS_COLLECTOR_PORT", 43117), 8_000);
    await waitFor(port("HHS_MISSION_CONTROL_PORT", 43118), 8_000);
    const applicationSecurity = assessApplicationListeners(
      await inspectWindowsListeners([port("HHS_COLLECTOR_PORT", 43117), port("HHS_MISSION_CONTROL_PORT", 43118)]),
      [port("HHS_COLLECTOR_PORT", 43117), port("HHS_MISSION_CONTROL_PORT", 43118)]
    );
    if (!applicationSecurity.safe) throw new Error("Application binding verification failed.");
    await writeFile(STATE_FILE, `${JSON.stringify(managed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    await rollbackStartup(managed);
    throw new Error("HHS startup blocked: local-only binding verification failed. Started services were stopped; private output was suppressed.");
  }
  console.log("HHS local services are up.");
  console.log(`Mission Control: http://127.0.0.1:${port("HHS_MISSION_CONTROL_PORT", 43118)}`);
  console.log(`Collector: http://127.0.0.1:${port("HHS_COLLECTOR_PORT", 43117)}`);
  console.log("Supabase API: http://127.0.0.1:55021");
  console.log("Supabase Studio: http://127.0.0.1:55023");
  console.log("Binding verification: loopback-only");
  console.log("Pairing code: .runtime\\collector-pairing-code.private (private; do not share)");
  console.log("Hermes and browser automation were not launched.");
}

async function down(): Promise<void> {
  const state = await readState();
  await stopManaged(state.collector);
  await stopManaged(state.mission_control);
  await rm(STATE_FILE, { force: true });
  await rm(path.join(RUNTIME, "collector-pairing-code.private"), { force: true });
  if (await supabaseIsPresent()) await runSupabase("stop");
  console.log("HHS managed local services are down. Database files were not deleted.");
  console.log("Hermes and browser automation were not touched.");
}

function startManaged(entry: string): { pid: number; entry: string; started_at: string } {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, HHS_SAFE_BACKGROUND: "1" }
  });
  child.unref();
  if (!child.pid) throw new Error(`Could not start ${entry}.`);
  return { pid: child.pid, entry, started_at: new Date().toISOString() };
}

async function stopManaged(item: unknown): Promise<void> {
  if (!isManaged(item)) return;
  try {
    process.kill(item.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 350));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function runSupabase(action: "start" | "stop"): Promise<void> {
  const executable = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "supabase.cmd" : "supabase");
  const args = action === "start"
    ? ["start", "--network-id", HHS_LOOPBACK_NETWORK, "--output-format", "json", "--log-level", "error"]
    : ["stop", "--output-format", "json", "--log-level", "error"];
  const proxy = action === "start" ? await startDockerLoopbackProxy() : undefined;
  try {
    await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: ROOT, windowsHide: true, shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: proxy ? { ...process.env, DOCKER_HOST: proxy.url } : process.env
    });
    let capturedBytes = 0;
    const capture = (chunk: Buffer) => {
      capturedBytes += chunk.length;
      if (capturedBytes > 8 * 1024 * 1024) child.kill();
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Supabase ${action} failed with private output suppressed.`)));
    });
  } finally {
    await proxy?.close();
  }
}

async function ensureLoopbackNetwork(): Promise<void> {
  let network: Array<{ Driver?: string; Options?: Record<string, string> }> | undefined;
  try {
    const { stdout } = await execFileAsync("docker", ["network", "inspect", HHS_LOOPBACK_NETWORK], {
      cwd: ROOT, windowsHide: true, timeout: 8_000, maxBuffer: 2 * 1024 * 1024
    });
    network = JSON.parse(stdout) as Array<{ Driver?: string; Options?: Record<string, string> }>;
  } catch {
    await execFileAsync("docker", [
      "network", "create", "--driver", "bridge",
      "--opt", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1",
      "--label", "com.hhs.local-only=true", HHS_LOOPBACK_NETWORK
    ], { cwd: ROOT, windowsHide: true, timeout: 12_000, maxBuffer: 2 * 1024 * 1024 });
    const { stdout } = await execFileAsync("docker", ["network", "inspect", HHS_LOOPBACK_NETWORK], {
      cwd: ROOT, windowsHide: true, timeout: 8_000, maxBuffer: 2 * 1024 * 1024
    });
    network = JSON.parse(stdout) as Array<{ Driver?: string; Options?: Record<string, string> }>;
  }
  const current = network[0];
  if (current?.Driver !== "bridge"
    || current.Options?.["com.docker.network.bridge.host_binding_ipv4"] !== "127.0.0.1") {
    throw new Error("Dedicated Docker network is not loopback-only.");
  }
}

async function rollbackStartup(managed: Record<string, unknown>): Promise<void> {
  await stopManaged(managed.collector);
  await stopManaged(managed.mission_control);
  await rm(STATE_FILE, { force: true });
  await rm(path.join(RUNTIME, "collector-pairing-code.private"), { force: true });
  if (await supabaseIsPresent()) {
    try { await runSupabase("stop"); } catch { /* Preserve the original fixed safe failure. */ }
  }
}

async function readState(): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(STATE_FILE, "utf8")) as Record<string, unknown>; }
  catch { return {}; }
}

function isManaged(value: unknown): value is { pid: number; entry: string } {
  return Boolean(value && typeof value === "object" && Number.isInteger((value as { pid?: number }).pid)
    && String((value as { entry?: string }).entry).startsWith("apps/"));
}

async function listening(portNumber: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: portNumber });
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitFor(portNumber: number, timeout: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await listening(portNumber)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Local service on port ${portNumber} did not become ready.`);
}

async function anyListening(ports: readonly number[]): Promise<boolean> {
  return (await Promise.all(ports.map(listening))).some(Boolean);
}

async function supabaseIsPresent(): Promise<boolean> {
  if (await anyListening(SUPABASE_HOST_PORTS)) return true;
  try {
    return (await inspectDockerBindings()).length > 0;
  } catch {
    return false;
  }
}

function mark(state: string): string { return state === "ready" ? "[OK]" : state === "degraded" ? "[!]" : "[X]"; }
function port(name: string, fallback: number): number { return Number(process.env[name] ?? fallback); }
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
