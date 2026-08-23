// `apps/text` input-moderation posture — the PLATFORM half.
//
// TASK-799 lane B removed six env vars that expressed three different KINDS of
// decision under one prefix. Splitting them by CARDINALITY (owner decision D-1)
// is what makes each one governable:
//
// | Retired env var                              | Kind             | Home |
// |---|---|---|
// | `TEXT_EXTERNAL_GUARDRAIL_ENABLED`            | platform switch  | HERE (`global-kv`, PULL) |
// | `TEXT_EXTERNAL_GUARDRAIL_TIMEOUT_S`          | platform tuning  | HERE |
// | `TEXT_EXTERNAL_GUARDRAIL_MAX_RETRIES`        | platform tuning  | HERE |
// | `TEXT_EXTERNAL_GUARDRAIL_RETRY_BACKOFF_MS`   | platform tuning  | HERE |
// | `TEXT_EXTERNAL_GUARDRAIL_REQUIRE_MEDICAL`    | **tenant policy**| PUSH — per-request `guardrail_policy` |
// | `TEXT_EXTERNAL_GUARDRAIL_INCLUDE_REASONING`  | **tenant policy**| PUSH |
//
// The bottom two are the reason this could not be one family. A non-clinical
// tenant needs `requireMedical` off while every other tenant keeps it on, and a
// process-wide boolean can express only one of those — so the real choice the
// env var offered was "redeploy, or force clinical validation on a tenant it
// does not fit". They travel the PUSH channel instead (D-1 rule 3: anything that
// could ever differ per tenant is pushed), which is also why they declare no
// `consumedBy` here: naming a service would turn one cached snapshot per process
// into one per tenant, exactly what the pull route exists to avoid.
//
// The PLATFORM DEFAULTS for those two ARE registered here, at `maxScope: 'system'`
// — a platform admin sets what a tenant inherits when it has no opinion. The
// tenant's own value never comes from this tier.
//
// The FAIL POSTURE is deliberately absent, in both tiers: a transient guardrail
// error is absorbed by the bounded retry and a sustained outage REJECTS. There is
// no `failOpen` key here because an errored guardrail must never return
// `allowed: true`, and a key that could be set to make it do so is not a
// configuration surface — it is a way to ship unmoderated PHI.
//
// Defaults are transcribed verbatim from `apps/text`'s own floors
// (`core/runtime_defaults.py`), so an unwritten row resolves to exactly the
// behaviour in force today.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ TWO WIRING STEPS REMAIN, and they are OUTSIDE lane B's file boundary:
//
//   1. `registry.ts` — add `...TEXT_GUARDRAIL_POSTURE_SETTINGS` to the assembled
//      registry. Until then these descriptors are inert.
//   2. `effective-config.service.ts` — add an `externalGuardrail` VIEW over the
//      resolved map, in the shape `apps/text` already consumes
//      (`core/effective_config.py::external_guardrail` →
//      `{ enabled, timeoutS, maxRetries, retryBackoffMs, requireMedical,
//         includeReasoning }`). The response groups are hand-shaped views
//      (`retentionView` / `concurrencyView`), not a generic dotted-key fold, so
//      a descriptor alone does not put a key on the wire.
//
// `apps/text` degrades correctly in the meantime: an absent group keeps the
// in-code floors, which are the retired env defaults, so nothing changes
// behaviour before the wiring lands.

import { SettingDescriptor } from '../registry.types';

/**
 * Registry key → the value `apps/text` falls back to when no row is written.
 * Shared with the service so the two can never drift.
 *
 * `enabled: false` mirrors the retired `TEXT_EXTERNAL_GUARDRAIL_ENABLED`
 * default, and it is deliberate rather than a kill-switch inversion: local dev
 * and hermetic CI run with no guardrail peer at all, so a default-on switch
 * would 503 every generation in a fresh checkout. Turning moderation ON for a
 * clinical deployment is now a platform-admin action in the console — which is
 * the point, because it can be done, and audited, without a redeploy.
 */
export const TEXT_GUARDRAIL_POSTURE_DEFAULTS = {
  'text.externalGuardrail.enabled': false,
  'text.externalGuardrail.timeoutS': 10,
  'text.externalGuardrail.maxRetries': 2,
  'text.externalGuardrail.retryBackoffMs': 100,
  'text.externalGuardrail.requireMedical': true,
  'text.externalGuardrail.includeReasoning': false,
} as const;

export type TextGuardrailPostureKey = keyof typeof TEXT_GUARDRAIL_POSTURE_DEFAULTS;

type KeyMeta = {
  label: string;
  description: string;
  dataType: 'boolean' | 'number';
  /** Platform DEFAULT for a value a tenant may override per request (PUSH). */
  tenantOverridable?: boolean;
};

const META: Record<TextGuardrailPostureKey, KeyMeta> = {
  'text.externalGuardrail.enabled': {
    label: 'Text input moderation enabled',
    dataType: 'boolean',
    description:
      'Whether `POST /generate` screens the prompt through the guardrail service before generating. ' +
      'OFF by default so a deployment with no guardrail peer still serves; a clinical deployment turns ' +
      'it on here rather than by redeploying with an env var. The fail posture is NOT configurable: ' +
      'once on, a transient guardrail error is absorbed by the bounded retry below and a sustained ' +
      'outage REJECTS — an errored guardrail can never allow a prompt through.',
  },
  'text.externalGuardrail.timeoutS': {
    label: 'Guardrail call timeout (s)',
    dataType: 'number',
    description:
      'Per-attempt timeout on the moderation call. Worst-case added latency under a HANG-style outage ' +
      'is roughly `(maxRetries + 1) x timeoutS` plus backoff, so raise it only against the caller-side ' +
      'request timeout that bounds it.',
  },
  'text.externalGuardrail.maxRetries': {
    label: 'Guardrail retry budget',
    dataType: 'number',
    description:
      'EXTRA attempts after the first (total tries = maxRetries + 1). This is what makes the posture ' +
      'degrade-safe rather than brittle: a momentary blip is absorbed and the prompt proceeds on a clean ' +
      're-check, while only a sustained outage exhausts the budget and fails closed. 0 = no retry.',
  },
  'text.externalGuardrail.retryBackoffMs': {
    label: 'Guardrail retry backoff (ms)',
    dataType: 'number',
    description:
      'Linear backoff between moderation retries: attempt N waits `N x retryBackoffMs`. Counts toward ' +
      'the latency ceiling described under the timeout.',
  },
  'text.externalGuardrail.requireMedical': {
    label: 'Require medical content (platform default)',
    dataType: 'boolean',
    tenantOverridable: true,
    description:
      'The platform default for clinical enforcement: a reachable guardrail must classify the prompt as ' +
      'medical for it to be allowed. This is the value a tenant inherits when it has expressed NO opinion ' +
      '— a tenant that has one sends it per request, and tenant wins. Setting this false is an explicit, ' +
      'documented non-clinical posture for tenants with no opinion of their own, never a silent default.',
  },
  'text.externalGuardrail.includeReasoning': {
    label: 'Include guardrail reasoning (platform default)',
    dataType: 'boolean',
    tenantOverridable: true,
    description:
      "Whether the moderation call asks guardrail to return its reasoning. Off by default: the reasoning " +
      'quotes the prompt, so it widens what a verdict carries back across a service boundary. Same ' +
      'tenant-inherits-on-absence semantics as requireMedical.',
  },
};

export const TEXT_GUARDRAIL_POSTURE_SETTINGS: SettingDescriptor[] = (
  Object.keys(TEXT_GUARDRAIL_POSTURE_DEFAULTS) as TextGuardrailPostureKey[]
).map<SettingDescriptor>((key) => ({
  key,
  // D-2: `global-kv` is the one tier with a complete read + write + cascade +
  // invalidate loop. A bespoke table for one service's posture is the failure
  // that decision exists to prevent.
  tier: 'global-kv',
  // Every key here is PLATFORM-scope — cardinality 1 per service — so the pull
  // route stays exactly one cached snapshot per process. The tenant half of the
  // posture is PUSHED per request and is deliberately not on this wire.
  consumedBy: ['text'],
  dataType: META[key].dataType,
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  // Tuning and a rollout switch: an unwritten row must degrade to today's
  // behaviour, not to an outage. `apps/text` mirrors this — an absent group
  // keeps the in-code floor.
  failMode: 'open-to-default',
  category: 'Guardrail Policy',
  label: META[key].label,
  description: META[key].description,
  default: TEXT_GUARDRAIL_POSTURE_DEFAULTS[key],
}));
