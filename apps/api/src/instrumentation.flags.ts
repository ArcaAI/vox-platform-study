/**
 * Telemetry enablement rules for the API gateway.
 *
 * Split out of `instrumentation.ts` because that module starts the OTel SDK as
 * an import side effect (it is preloaded with `node --import`), which makes it
 * untestable. This file is pure: env in, decision out.
 *
 * WHY `OTEL_TRACES_ENABLED` NEEDED IMPLEMENTING RATHER THAN DELETING
 * The variable is set by the k8s overlays, `apps/api/Dockerfile`,
 * `apps/nlp/Dockerfile`, `.gitlab-ci.yml` and `.gitlab/ci/test.yml`, and
 * `apps/nlp` genuinely reads it (`nlp/core/config.py`). On the gateway side the
 * only reader was `OpenTelemetryService.getConfigFromEnv()` in
 * `packages/applications`, where it gated a `trace.getTracer()` call that
 * returns a working handle either way — i.e. it controlled nothing. Deleting it
 * would have desynchronised the gateway from NLP, which honours it. So: keep
 * the name, give it teeth, and keep the two runtimes' semantics aligned.
 */

/** The resolved telemetry plan `instrumentation.ts` acts on. */
export interface TelemetryPlan {
  /** Start the NodeSDK at all. */
  sdkEnabled: boolean;
  /** Export spans. Independent of `sdkEnabled` so logs and CONTEXT PROPAGATION survive. */
  tracesEnabled: boolean;
  /** Export log records. */
  logsEnabled: boolean;
  /**
   * Which trace exporter the SDK should be built with. `'none'` means
   * `instrumentation.ts` passes an explicit empty `spanProcessors` list, which
   * suppresses both the configured exporter and NodeSDK's
   * `OTEL_TRACES_EXPORTER` env fallback. Deliberately expressed in code rather
   * than by writing an env var: this process must not mutate its own
   * environment, and a new `OTEL_*` variable would need a `turbo.json#globalEnv`
   * entry to be legal in this repo.
   */
  traceExporterName: 'otlp' | 'none';
  /** Human-readable explanation, logged at boot. */
  reason: string;
}

/**
 * Environment values that mean "off".
 *
 * Deliberately an explicit list rather than `!== 'true'`: an unrecognised value
 * (a typo, an unexpanded template) resolves to ENABLED. Failing open here is
 * the right direction — silently losing traces is precisely the defect class
 * exists to close, and it is the one that took months to notice.
 */
const FALSY = new Set(['false', '0', 'no', 'off']);

function isExplicitlyDisabled(value: string | undefined): boolean {
  if (value == null) return false;
  return FALSY.has(value.trim().toLowerCase());
}

function isExplicitlyEnabled(value: string | undefined): boolean {
  if (value == null) return false;
  return value.trim().toLowerCase() === 'true';
}

export function resolveTelemetryPlan(env: NodeJS.ProcessEnv | Record<string, string | undefined>): TelemetryPlan {
  const disabled = (reason: string): TelemetryPlan => ({
    sdkEnabled: false,
    tracesEnabled: false,
    logsEnabled: false,
    traceExporterName: 'none',
    reason,
  });

  // `OTEL_SDK_DISABLED` is the existing hard kill-switch and stays first.
  if (isExplicitlyEnabled(env.OTEL_SDK_DISABLED)) {
    return disabled('OTEL_SDK_DISABLED=true');
  }

  // Telemetry export is explicit opt-in — no localhost fallback.
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return disabled('OTEL_EXPORTER_OTLP_ENDPOINT not set');
  }

  const tracesEnabled = !isExplicitlyDisabled(env.OTEL_TRACES_ENABLED);

  return {
    // The SDK starts even with traces off. That is load-bearing: starting it is
    // what registers the W3C propagator and the async-hooks context manager, so
    // a gateway with traces disabled still CONTINUES and FORWARDS the trace
    // context of services that do have them on. A service that severs its
    // neighbours' traces to save its own export volume is a worse outcome than
    // the volume.
    sdkEnabled: true,
    tracesEnabled,
    logsEnabled: true,
    traceExporterName: tracesEnabled ? 'otlp' : 'none',
    reason: tracesEnabled
      ? `telemetry enabled (endpoint=${env.OTEL_EXPORTER_OTLP_ENDPOINT})`
      : 'OTEL_TRACES_ENABLED=false — span export off, logs and trace-context propagation still on',
  };
}
