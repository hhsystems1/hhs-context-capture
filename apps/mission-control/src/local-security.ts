import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const HHS_LOOPBACK_NETWORK = "hhs-memory-loopback-v1";
export const SUPABASE_HOST_PORTS = [55021, 55022, 55023] as const;
export const HHS_APPLICATION_PORTS = [43117, 43118] as const;

export interface DockerPortBinding {
  container: string;
  containerPort: number;
  hostAddress: string;
  hostPort: number;
}

export interface WindowsListener {
  localAddress: string;
  localPort: number;
  owningProcess: number;
}

export interface BindingAssessment {
  safe: boolean;
  state: "ready" | "degraded" | "offline";
  detail: string;
  unsafeAddresses: string[];
  missingPorts: number[];
}

export function isLoopbackAddress(value: string): boolean {
  const address = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return address === "127.0.0.1" || address === "::1" || address === "0:0:0:0:0:0:0:1"
    || address === "::ffff:127.0.0.1";
}

export function assessPublishedBindings(
  bindings: DockerPortBinding[],
  listeners: WindowsListener[],
  requiredPorts: readonly number[]
): BindingAssessment {
  if (!bindings.length && !listeners.length) {
    return { safe: false, state: "offline", detail: "No local service bindings detected", unsafeAddresses: [], missingPorts: [...requiredPorts] };
  }
  const relevantListeners = listeners.filter((listener) => requiredPorts.includes(listener.localPort));
  const unsafeAddresses = [
    ...bindings.filter((binding) => !isLoopbackAddress(binding.hostAddress)).map((binding) => printableAddress(binding.hostAddress)),
    ...relevantListeners.filter((listener) => !isLoopbackAddress(listener.localAddress)).map((listener) => printableAddress(listener.localAddress))
  ].filter((value, index, all) => all.indexOf(value) === index);
  const verifiedPorts = new Set(bindings.filter((binding) => isLoopbackAddress(binding.hostAddress)).map((binding) => binding.hostPort));
  const listenerPorts = new Set(relevantListeners.filter((listener) => isLoopbackAddress(listener.localAddress)).map((listener) => listener.localPort));
  const missingPorts = requiredPorts.filter((port) => !verifiedPorts.has(port) || !listenerPorts.has(port));
  const safe = unsafeAddresses.length === 0 && missingPorts.length === 0;
  const endpoints = bindings.filter((binding) => isLoopbackAddress(binding.hostAddress))
    .map((binding) => `${normalizeAddress(binding.hostAddress)}:${binding.hostPort}`)
    .filter((value, index, all) => all.indexOf(value) === index).sort();
  return {
    safe,
    state: safe ? "ready" : "degraded",
    detail: safe ? `Loopback only: ${endpoints.join(", ")}` :
      `UNSAFE OR UNVERIFIED BINDING: ${unsafeAddresses.length ? unsafeAddresses.join(", ") : `missing ${missingPorts.join(", ")}`}`,
    unsafeAddresses,
    missingPorts
  };
}

export function assessApplicationListeners(
  listeners: WindowsListener[],
  requiredPorts: readonly number[]
): BindingAssessment {
  const unsafeAddresses = listeners.filter((listener) => requiredPorts.includes(listener.localPort) && !isLoopbackAddress(listener.localAddress))
    .map((listener) => printableAddress(listener.localAddress))
    .filter((value, index, all) => all.indexOf(value) === index);
  const safePorts = new Set(listeners.filter((listener) => requiredPorts.includes(listener.localPort) && isLoopbackAddress(listener.localAddress))
    .map((listener) => listener.localPort));
  const missingPorts = requiredPorts.filter((port) => !safePorts.has(port));
  const safe = unsafeAddresses.length === 0 && missingPorts.length === 0;
  return {
    safe,
    state: safe ? "ready" : listeners.length ? "degraded" : "offline",
    detail: safe ? `Loopback only: ${requiredPorts.map((port) => `127.0.0.1:${port}`).join(", ")}` :
      `UNSAFE OR UNVERIFIED BINDING: ${unsafeAddresses.length ? unsafeAddresses.join(", ") : `missing ${missingPorts.join(", ")}`}`,
    unsafeAddresses,
    missingPorts
  };
}

export function sanitizeSensitiveOutput(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{10,}){1,2}\b/g, "[REDACTED_JWT]")
    .replace(/(anon|service[_ -]?role|secret|password|pairing[_ -]?code|api[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/(?!127\.0\.0\.1(?::|\/)|localhost(?::|\/)|\[::1\](?::|\/))[^\s"'<>]+/gi, "[REDACTED_NONLOCAL_URL]");
}

export async function inspectDockerBindings(networkName = HHS_LOOPBACK_NETWORK): Promise<DockerPortBinding[]> {
  const { stdout: networkJson } = await execFileAsync("docker", ["network", "inspect", networkName], {
    windowsHide: true, timeout: 8_000, maxBuffer: 2 * 1024 * 1024
  });
  const network = JSON.parse(networkJson) as Array<{ Containers?: Record<string, { Name?: string }> }>;
  const ids = Object.keys(network[0]?.Containers ?? {});
  if (!ids.length) return [];
  const { stdout } = await execFileAsync("docker", ["inspect", ...ids], {
    windowsHide: true, timeout: 12_000, maxBuffer: 8 * 1024 * 1024
  });
  const containers = JSON.parse(stdout) as Array<{
    Name?: string;
    HostConfig?: { PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> };
  }>;
  const bindings: DockerPortBinding[] = [];
  for (const container of containers) {
    for (const [containerPort, rows] of Object.entries(container.HostConfig?.PortBindings ?? {})) {
      for (const row of rows ?? []) {
        const hostPort = Number(row.HostPort);
        const targetPort = Number(containerPort.split("/")[0]);
        if (Number.isInteger(hostPort) && Number.isInteger(targetPort)) {
          bindings.push({
            container: safeContainerName(container.Name),
            containerPort: targetPort,
            hostAddress: row.HostIp ?? "",
            hostPort
          });
        }
      }
    }
  }
  return bindings.sort((left, right) => left.hostPort - right.hostPort || left.container.localeCompare(right.container));
}

export async function inspectWindowsListeners(ports: readonly number[]): Promise<WindowsListener[]> {
  const isWindows = process.platform === "win32";
  const isWsl = process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME);
  if (!isWindows && !isWsl) throw new Error("Windows or WSL listener verification is required for this local stack.");
  const safePorts = ports.filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65535);
  if (safePorts.length !== ports.length) throw new Error("Listener verification received an invalid port.");
  const script = `$ports=@(${safePorts.join(",")});@(` +
    "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|" +
    "Where-Object{$ports -contains $_.LocalPort}|" +
    "Select-Object LocalAddress,LocalPort,OwningProcess)|ConvertTo-Json -Compress";
  const shell = isWindows
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "powershell.exe";
  const { stdout } = await execFileAsync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: 8_000, maxBuffer: 1024 * 1024
  });
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout) as Record<string, unknown> | Array<Record<string, unknown>>;
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    localAddress: String(row.LocalAddress ?? ""),
    localPort: Number(row.LocalPort),
    owningProcess: Number(row.OwningProcess)
  })).sort((left, right) => left.localPort - right.localPort || left.localAddress.localeCompare(right.localAddress));
}

export async function verifySupabaseLoopback(): Promise<{ assessment: BindingAssessment; bindings: DockerPortBinding[]; listeners: WindowsListener[] }> {
  const [bindings, listeners] = await Promise.all([
    inspectDockerBindings(),
    inspectWindowsListeners(SUPABASE_HOST_PORTS)
  ]);
  return { assessment: assessPublishedBindings(bindings, listeners, SUPABASE_HOST_PORTS), bindings, listeners };
}

export async function runFailClosed<T>(
  start: () => Promise<T>,
  verify: (value: T) => Promise<boolean>,
  rollback: () => Promise<void>
): Promise<T> {
  try {
    const value = await start();
    if (!(await verify(value))) throw new Error("Local security verification failed.");
    return value;
  } catch (error) {
    await rollback();
    throw error;
  }
}

export function shouldStartManaged(listenerPresent: boolean): boolean {
  return !listenerPresent;
}

function printableAddress(value: string): string {
  return value.trim() || "<unspecified>";
}

function normalizeAddress(value: string): string {
  return value.includes(":") ? `[${value.replace(/^\[|\]$/g, "")}]` : value;
}

function safeContainerName(value: string | undefined): string {
  const name = (value ?? "supabase-service").replace(/^\//, "");
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(name) ? name : "supabase-service";
}
