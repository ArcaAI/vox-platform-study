/**
 * `OTEL_TRACES_ENABLED` is now a real control.
 *
 * The k8s overlays, both service Dockerfiles and `.gitlab-ci.yml` all set this
 * variable. Before this change the ONLY code that read it was
 * `OpenTelemetryService.getConfigFromEnv()` in `packages/applications`, where it
 * gated nothing but a `trace.getTracer()` handle — a call that returns a usable
 * (no-op or real) tracer either way. So the flag looked like a switch, was
 * wired into every deployment surface, and controlled nothing.
 *
 * A flag that looks like a control but isn't is worse than no flag: an operator
 * responding to an incident by setting `OTEL_TRACES_ENABLED=false` would have
 * seen span volume continue unchanged.
 *
 * These tests pin the resolution rules against the pre-existing
 * `OTEL_SDK_DISABLED` semantics they are modelled on.
 */
import { describe, expect, it } from 'vitest';
import { resolveTelemetryPlan } from '../instrumentation.flags';

describe('ResolveTelemetryPlan', () => {
  describe('the endpoint remains the master switch (explicit opt-in, no localhost fallback)', () => {
    it('disables everything when no endpoint is configured', () => {
      const plan = resolveTelemetryPlan({});
      expect(plan.sdkEnabled).toBe(false);
      expect(plan.reason).toMatch(/OTEL_EXPORTER_OTLP_ENDPOINT/);
    });

    it('disables everything when OTEL_SDK_DISABLED=true, endpoint or not', () => {
      const plan = resolveTelemetryPlan({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4317',
        OTEL_SDK_DISABLED: 'true',
      });
      expect(plan.sdkEnabled).toBe(false);
      expect(plan.reason).toBe('OTEL_SDK_DISABLED=true');
    });
  });

  describe('OTEL_TRACES_ENABLED gates TRACES ONLY', () => {
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4317' };

    it('traces are on when the variable is absent (existing deployments keep working)', () => {
      const plan = resolveTelemetryPlan({ ...endpoint });
      expect(plan.sdkEnabled).toBe(true);
      expect(plan.tracesEnabled).toBe(true);
    });

    it('traces are on for the value the overlays and Dockerfiles set', () => {
      expect(resolveTelemetryPlan({ ...endpoint, OTEL_TRACES_ENABLED: 'true' }).tracesEnabled).toBe(true);
    });

    it('traces are OFF for an explicit false', () => {
      const plan = resolveTelemetryPlan({ ...endpoint, OTEL_TRACES_ENABLED: 'false' });
      expect(plan.sdkEnabled).toBe(true);
      expect(plan.tracesEnabled).toBe(false);
    });

    it('accepts the usual falsy spellings CI and shell scripts produce', () => {
      for (const value of ['false', 'FALSE', 'False', '0', 'no', ' false ']) {
        expect(resolveTelemetryPlan({ ...endpoint, OTEL_TRACES_ENABLED: value }).tracesEnabled).toBe(false);
      }
    });

    it('treats an unrecognised value as ENABLED rather than silently going dark', () => {
      // Failing open on a typo is the right direction: losing traces silently
      // is exactly the class of defect exists to close.
      expect(resolveTelemetryPlan({ ...endpoint, OTEL_TRACES_ENABLED: 'maybe' }).tracesEnabled).toBe(true);
    });

    it('LOGS keep flowing when only traces are disabled', () => {
      const plan = resolveTelemetryPlan({ ...endpoint, OTEL_TRACES_ENABLED: 'false' });
      expect(plan.logsEnabled).toBe(true);
    });

    it('keeps CONTEXT PROPAGATION alive when traces are disabled', () => {
      // The SDK still starts, so a W3C propagator is still registered and
      // inbound `traceparent` headers are still honoured — a service with
      // traces off must not become a hole that severs OTHER services' traces.
      const plan = resolveTelemetryPlan({ ...endpoint, OTEL_TRACES_ENABLED: 'false' });
      expect(plan.sdkEnabled).toBe(true);
      expect(plan.traceExporterName).toBe('none');
    });

    it('names the otlp exporter when traces are enabled', () => {
      expect(resolveTelemetryPlan({ ...endpoint }).traceExporterName).toBe('otlp');
    });
  });

  it('reports a human-readable reason for every disabled outcome', () => {
    expect(resolveTelemetryPlan({}).reason).toBeTruthy();
    expect(resolveTelemetryPlan({ OTEL_SDK_DISABLED: 'true' }).reason).toBeTruthy();
    expect(
      resolveTelemetryPlan({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4317', OTEL_TRACES_ENABLED: 'false' }).reason,
    ).toMatch(/OTEL_TRACES_ENABLED=false/);
  });
});
