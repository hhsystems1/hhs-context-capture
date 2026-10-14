// Bound connection and response-body reads without changing the model policy.
export function providerRequestSignal(env = process.env) {
  const milliseconds = Number(env.HHS_RECONSTRUCTION_REQUEST_TIMEOUT_MS ?? 240000);
  if (!Number.isInteger(milliseconds) || milliseconds < 1000 || milliseconds > 900000) {
    throw new Error("HHS_RECONSTRUCTION_REQUEST_TIMEOUT_MS must be 1000..900000.");
  }
  return globalThis.AbortSignal.timeout(milliseconds);
}
