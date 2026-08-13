/**
 * Boot-time PHI-safe telemetry audit.
 *
 * OTel GenAI instrumentation defaults to NOT capturing prompt/completion
 * content, but the switch (`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`)
 * is an instrumentation-library convention absent from the official OTel SDK
 * env-var spec — a library that ignores it captures content anyway (PHI
 * leak). This audit pins the switch at boot, mirroring
 * `assertJwtSecretNotPlaceholder`'s "refuse to boot on a bad security
 * knob" posture, but scoped to `NODE_ENV=production` only: dev/test never
 * force the var, since local/test environments are not a PHI exposure
 * surface and the env-sample flow already pins `NO_CONTENT` as the template
 * default.
 *
 * Reads `process.env` directly (an injectable map for testing) rather than
 * the zod-validated `apiEnv()` result — the schema treats this variable as
 * `open-to-default` with NO runtime default, precisely so "unset" and
 * "explicitly NO_CONTENT" stay distinguishable here.
 */

import { describe, it, expect } from 'vitest';
import { assertGenaiContentCaptureDisabled } from '../genai-content-capture-audit';

const fakeEnv = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv => ({ ...overrides }) as NodeJS.ProcessEnv;

describe('bootstrap refuses unsafe GenAI content-capture in production', () => {
  it('throws in production when the var is unset', () => {
    expect(() => assertGenaiContentCaptureDisabled(fakeEnv({ NODE_ENV: 'production' }))).toThrowError(/Refusing to boot.*OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT/);
  });

  it('throws in production when the var is set to a permissive value', () => {
    expect(() =>
      assertGenaiContentCaptureDisabled(
        fakeEnv({ NODE_ENV: 'production', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'SPAN_AND_EVENT' }),
      ),
    ).toThrowError(/Refusing to boot.*OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT/);
  });

  it('throws in production for a near-miss (case/whitespace) value', () => {
    expect(() =>
      assertGenaiContentCaptureDisabled(fakeEnv({ NODE_ENV: 'production', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'no_content' })),
    ).toThrow();
  });

  it('passes in production when the var is exactly NO_CONTENT', () => {
    expect(() =>
      assertGenaiContentCaptureDisabled(fakeEnv({ NODE_ENV: 'production', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'NO_CONTENT' })),
    ).not.toThrow();
  });

  it('does not enforce in development, even when unset', () => {
    expect(() => assertGenaiContentCaptureDisabled(fakeEnv({ NODE_ENV: 'development' }))).not.toThrow();
  });

  it('does not enforce in test, even when set to a permissive value', () => {
    expect(() =>
      assertGenaiContentCaptureDisabled(fakeEnv({ NODE_ENV: 'test', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'SPAN_AND_EVENT' })),
    ).not.toThrow();
  });

  it('does not enforce when NODE_ENV is unset (defaults to development)', () => {
    expect(() => assertGenaiContentCaptureDisabled(fakeEnv({}))).not.toThrow();
  });
});
