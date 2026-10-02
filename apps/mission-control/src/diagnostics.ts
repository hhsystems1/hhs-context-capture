import { execFile } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import {
  assessApplicationListeners, HHS_APPLICATION_PORTS, inspectWindowsListeners, verifySupabaseLoopback
} from "./local-security.js";

const execFileAsync = promisify(execFile);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export interface ServiceState {
  state: "ready" | "degraded" | "offline";
  detail: string;
}

export interface SystemDiagnostics {
  docker: ServiceState;
  supabase: ServiceState;
  bindings: ServiceState;
  migrations: ServiceState;
  collector: ServiceState;
  extension: ServiceState & { version: string };
  git: ServiceState & { branch: string; checkpoint: string; clean: boolean };
  publication: ServiceState;
  checked_at: string;
}

export async function collectDiagnostics(root = process.cwd()): Promise<SystemDiagnostics> {
  const [docker, supabase, bindings, migrations, collector, extension, git, publication] = await Promise.all([
    commandState("docker", ["info", "--format", "{{.ServerVersion}}"], "Docker engine"),
    portState(55021, "Local Supabase API"),
    bindingState(),
    migrationState(root),
    httpState(Number(process.env.HHS_COLLECTOR_PORT ?? "43117"), "/health", "Collector"),
    extensionState(root),
    gitState(root),
    publicationState(root)
  ]);
  return { docker, supabase, bindings, migrations, collector, extension, git, publication, checked_at: new Date().toISOString() };
}

async function bindingState(): Promise<ServiceState> {
  try {
    const supabase = await verifySupabaseLoopback();
    const applicationListeners = await inspectWindowsListeners(HHS_APPLICATION_PORTS);
    const applications = assessApplicationListeners(applicationListeners, HHS_APPLICATION_PORTS);
    if (supabase.assessment.state === "offline" && applications.state === "offline") {
      return { state: "offline", detail: "No HHS local listeners detected" };
    }
    if (!supabase.assessment.safe || !applications.safe) {
      return { state: "degraded", detail: `UNSAFE: Supabase ${supabase.assessment.detail}; applications ${applications.detail}` };
    }
    return {
      state: "ready",
      detail: `${supabase.assessment.detail}; ${applications.detail}`
    };
  } catch {
    return { state: "degraded", detail: "UNSAFE: actual bind addresses could not be verified" };
  }
}

async function commandState(command: string, args: string[], label: string): Promise<ServiceState> {
  try {
    const { stdout } = await execFileAsync(command, args, { windowsHide: true, timeout: 5_000 });
    return { state: "ready", detail: `${label} ${stdout.trim() || "ready"}` };
  } catch {
    return { state: "offline", detail: `${label} is unavailable` };
  }
}

async function portState(port: number, label: string): Promise<ServiceState> {
  const ready = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(800);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
  return { state: ready ? "ready" : "offline", detail: `${label} is ${ready ? "reachable" : "not reachable"}` };
}

async function httpState(port: number, route: string, label: string): Promise<ServiceState> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(1_000) });
    return { state: response.ok ? "ready" : "degraded", detail: `${label} returned HTTP ${response.status}` };
  } catch {
    return { state: "offline", detail: `${label} is not listening` };
  }
}

async function migrationState(root: string): Promise<ServiceState> {
  try {
    const local = (await readdir(path.join(root, "supabase", "migrations")))
      .filter((name) => /^\d+_.+\.sql$/.test(name)).map((name) => name.split("_")[0]).sort();
    const executable = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "supabase.cmd" : "supabase");
    const { stdout } = await execFileAsync(executable, ["migration", "list", "--local", "--output-format", "json"], {
      cwd: root, windowsHide: true, timeout: 12_000, shell: process.platform === "win32"
    });
    const parsed = JSON.parse(stdout) as { migrations?: Array<{ local?: string; remote?: string }> };
    const remote = (parsed.migrations ?? []).map((item) => item.remote).filter((item): item is string => Boolean(item)).sort();
    const synchronized = local.length === remote.length && local.every((value, index) => value === remote[index]);
    return {
      state: synchronized ? "ready" : "degraded",
      detail: synchronized ? `${local.length} local migrations synchronized` : `${local.length} local / ${remote.length} applied`
    };
  } catch {
    return { state: "degraded", detail: "Migration synchronization could not be checked" };
  }
}

async function extensionState(root: string): Promise<SystemDiagnostics["extension"]> {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, "apps", "browser-extension", "manifest.json"), "utf8")) as { version?: string };
    const sourceRoot = path.join(root, "apps", "browser-extension", "src");
    const distRoot = path.join(root, "apps", "browser-extension", "dist");
    const sourceTimes = await Promise.all((await readdir(sourceRoot)).map(async (name) => (await stat(path.join(sourceRoot, name))).mtimeMs));
    const built = await Promise.all(["background.js", "content.js", "popup.js"].map(async (name) => {
      try { return (await stat(path.join(distRoot, name))).mtimeMs; } catch { return 0; }
    }));
    const current = Math.min(...built) >= Math.max(...sourceTimes);
    return {
      state: current ? "ready" : "degraded",
      detail: current ? "Build is current" : "Build is missing or older than source",
      version: manifest.version ?? "unknown"
    };
  } catch {
    return { state: "offline", detail: "Extension manifest is unavailable", version: "unknown" };
  }
}

async function gitState(root: string): Promise<SystemDiagnostics["git"]> {
  try {
    const [branch, checkpoint, status] = await Promise.all([
      execFileAsync("git", ["branch", "--show-current"], { cwd: root, windowsHide: true }),
      execFileAsync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, windowsHide: true }),
      execFileAsync("git", ["status", "--porcelain"], { cwd: root, windowsHide: true })
    ]);
    const clean = status.stdout.trim().length === 0;
    return {
      state: clean ? "ready" : "degraded",
      detail: clean ? "Worktree clean" : "Worktree has local changes",
      branch: branch.stdout.trim(),
      checkpoint: checkpoint.stdout.trim(),
      clean
    };
  } catch {
    return { state: "offline", detail: "Git state is unavailable", branch: "unknown", checkpoint: "unknown", clean: false };
  }
}

async function publicationState(root: string): Promise<ServiceState> {
  try {
    await Promise.all([
      access(path.join(root, "PUBLICATION_BLOCKED.md")),
      access(path.join(root, ".githooks", "pre-push"))
    ]);
    const [remote, hooks] = await Promise.all([
      execFileAsync("git", ["remote"], { cwd: root, windowsHide: true }),
      execFileAsync("git", ["config", "--get", "core.hooksPath"], { cwd: root, windowsHide: true })
    ]);
    const blocked = !remote.stdout.trim() && hooks.stdout.trim() === ".githooks";
    return {
      state: blocked ? "ready" : "degraded",
      detail: blocked ? "Publication blocked; no remote configured" : "Publication protection needs attention"
    };
  } catch {
    return { state: "degraded", detail: "Publication protection could not be confirmed" };
  }
}

export function assertLoopbackUrl(value: string): void {
  const url = new URL(value);
  if (!LOOPBACK.has(url.hostname)) throw new Error("Mission Control accepts only loopback database connections.");
}
