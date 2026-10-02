import {
  assessApplicationListeners, HHS_APPLICATION_PORTS, inspectWindowsListeners, verifySupabaseLoopback
} from "../apps/mission-control/src/local-security.js";

const supabase = await verifySupabaseLoopback();
const applicationListeners = await inspectWindowsListeners(HHS_APPLICATION_PORTS);
const applications = assessApplicationListeners(applicationListeners, HHS_APPLICATION_PORTS);
const passed = supabase.assessment.safe && applications.safe;

console.log(JSON.stringify({
  passed,
  docker_bindings: supabase.bindings.map((binding) => ({
    service: binding.container,
    container_port: binding.containerPort,
    host_address: binding.hostAddress,
    host_port: binding.hostPort
  })),
  windows_listeners: [...supabase.listeners, ...applicationListeners].map((listener) => ({
    local_address: listener.localAddress,
    local_port: listener.localPort
  })),
  wildcard_or_nonlocal_addresses: [
    ...supabase.assessment.unsafeAddresses,
    ...applications.unsafeAddresses
  ],
  missing_ports: [...supabase.assessment.missingPorts, ...applications.missingPorts]
}, null, 2));

if (!passed) process.exitCode = 1;
