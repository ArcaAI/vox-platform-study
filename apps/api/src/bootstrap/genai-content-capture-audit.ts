import { Logger } from '@nestjs/common';

/**
 * Boot-time PHI-safe telemetry audit (TASK-615 WS-G).
 *
 * OpenTelemetry's GenAI semantic-convention instrumentation defaults to NOT
 * capturing prompt/completion content, but the opt-in switch —
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` — is an
 * instrumentation-library convention, absent from the official OTel SDK
 * env-var spec (research-findings.md §2): a library that ignores it captures
 * content anyway, which for HOPE means PHI (prompts/completions/transcripts)
 * landing in spans. Layer 1 of the 4-layer PHI-safe telemetry defense
 * (docs/operations/telemetry-phi-guardrails.md) is pinning this switch to
 * `NO_CONTENT` everywhere; this audit turns "pinned" into "enforced" the same
 * way `assertJwtSecretNotPlaceholder` enforces the JWT secret isn't the dev
 * placeholder — called from `main.ts` and throwing propagates out of
 * `bootstrap()`, exiting the process non-zero before `app.listen()`.
 *
 * Scoped to `NODE_ENV=production` only (unlike the JWT check, which is
 * unconditional): dev/test are not a PHI exposure surface and the env-sample
 * flow already pins `NO_CONTENT` as the template default there, so forcing
 * the check everywhere would fail a plain checkout with no env file. A
 * misconfigured PRODUCTION deploy is the one case that must hard-refuse.
 *
 * Reads the raw env map rather than the zod-validated `apiEnv()` result
 * on purpose: the descriptor for this variable
 * (`apps/api/src/config/env.descriptors.ts`) is `open-to-default` with NO
 * runtime `default` (only a `sampleValue` for the generated sample files), so
 * "unset" and "explicitly NO_CONTENT" stay distinguishable at THIS layer —
 * an unset production var must refuse to boot, not silently resolve to a
 * safe-looking default.
 */
export function assertGenaiContentCaptureDisabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  const value = env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
  if (value === 'NO_CONTENT') return;

  const reason =
    value === undefined
      ? 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT is not set. Set it to the literal value NO_CONTENT before booting in production.'
      : `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT is set to ${JSON.stringify(value)}, not the required literal NO_CONTENT. A permissive value lets OTel GenAI instrumentation capture PHI-bearing prompt/completion content in spans.`;
  new Logger('GenaiContentCaptureAudit').error(reason);
  throw new Error(`Refusing to boot: ${reason}`);
}
