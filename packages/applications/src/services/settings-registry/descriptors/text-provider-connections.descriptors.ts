// `apps/text`'s registry surface.
//
// Since TASK-1035 (owner decisions OD-4, OD-5): the platform kill switch
// `text.externalGuardrail.enabled` and the platform default
// `text.externalGuardrail.requireMedical` are GONE. Guardrail screening and the medical judge run
// on every call; break-glass is a redeploy, never a setting. The table below is the history.
//
// This file used to declare TEXT's cloud-provider CONNECTION config as
// `tier: 'env'` — `TEXT_OPENAI_BASE_URL`, `TEXT_OPENAI_ORGANIZATION`,
// `TEXT_OPENAI_DEFAULT_MODEL`, `TEXT_ANTHROPIC_BASE_URL`,
// `TEXT_ANTHROPIC_DEFAULT_MODEL`, `TEXT_VERTEX_PROJECT`, `TEXT_VERTEX_LOCATION`,
// `TEXT_VERTEX_DEFAULT_MODEL` — on the reasoning that they were "non-secret
// platform routing used when a tenant has no enabled BYO connection".
//
// lane B removed every one of them from `apps/text`, and the reasoning
// is what changed rather than the mechanics. A platform routing value read from
// the process environment is one that no tenant can override and no admin can
// change without a redeploy — so "the platform default for a provider" and "the
// tenant's own connection" were two different data classes describing the same
// thing, with only the tenant half governable. There is one class now:
// `AiProviderConnection`, whose SYSTEM-tenant row IS the platform default and
// resolves through the same tenant → SYSTEM cascade, with `funding` derived from
// whichever row supplied it. `apps/text` holds no connection of its own and
// fails closed when none is injected.
//
// Those eight keys are therefore GONE from the registry, not re-tiered: a
// descriptor for an env var that no reader reads is exactly the kind of phantom
// declaration `pnpm env:sync --check` exists to catch, and leaving them would
// have kept them in `turbo.json#globalEnv` forever.
//
// What remains here is the part of TEXT's configuration that IS platform-scope
// and DOES belong in the control plane: the input-moderation posture.
//
// ── The guardrail posture, split by CARDINALITY (owner decision D-1) ─────────
//
// | Retired env var | Kind | Home |
// |---|---|---|
// | `TEXT_EXTERNAL_GUARDRAIL_ENABLED` | platform switch | HERE (`global-kv` kill-switch) |
// | `TEXT_EXTERNAL_GUARDRAIL_TIMEOUT_S` | platform tuning | HERE (`global-kv`, PULL) |
// | `TEXT_EXTERNAL_GUARDRAIL_MAX_RETRIES` | platform tuning | HERE |
// | `TEXT_EXTERNAL_GUARDRAIL_RETRY_BACKOFF_MS` | platform tuning | HERE |
// | `TEXT_EXTERNAL_GUARDRAIL_REQUIRE_MEDICAL` | **tenant policy**| HERE as the platform DEFAULT; the tenant's own value is PUSHED per request |
// | `TEXT_EXTERNAL_GUARDRAIL_INCLUDE_REASONING` | **tenant policy**| same |
//
// The bottom two are why this could not be one family. A non-clinical tenant
// needs `requireMedical` off while every other tenant keeps it on, and a
// process-wide boolean can express only one of those — so the real choice the
// env var offered was "redeploy, or force clinical validation on a tenant it
// does not fit". A tenant's own value travels the PUSH channel (per-request
// `guardrail_policy`), and what is registered here is only the default it
// inherits when it has expressed no opinion. That is also why every key below
// is `maxScope: 'system'`: putting a tenant-varying value on the PULL route
// would turn one cached snapshot per process into one per tenant, which is the
// bug D-1's split prevents.
//
// The FAIL POSTURE is deliberately absent from BOTH tiers. A transient guardrail
// error is absorbed by the bounded retry and a sustained outage REJECTS; there
// is no `failOpen` key because a key that could be set to make an errored
// guardrail allow a prompt is not a configuration surface, it is a way to ship
// unmoderated PHI.
//
// Defaults are transcribed verbatim from `apps/text`'s own floors
// (`core/runtime_defaults.py`), so an unwritten row resolves to exactly the
// behaviour in force today.
//
// ⚠ ONE WIRING STEP REMAINS, and it is outside lane B's file boundary:
// `effective-config.service.ts` needs an `externalGuardrail` VIEW over the
// resolved map, in the shape `apps/text` already consumes
// (`core/effective_config.py::external_guardrail` → `{ enabled, timeoutS,
// maxRetries, retryBackoffMs, requireMedical, includeReasoning }`). The response
// groups there are hand-shaped views (`retentionView` / `concurrencyView`), not
// a generic dotted-key fold, so `consumedBy` alone does not put a key on the
// wire. Until it lands `apps/text` keeps its in-code floors — which ARE the
// retired env defaults, so nothing changes behaviour in the meantime.

import { SettingDescriptor } from '../registry.types';

/**
 * Registry key → the value `apps/text` falls back to when no row is written.
 * Transcribed from `apps/text/src/text/core/runtime_defaults.py`.
 */
export const TEXT_GUARDRAIL_POSTURE_DEFAULTS = {
  'text.externalGuardrail.timeoutS': 120,
  'text.externalGuardrail.maxRetries': 2,
  'text.externalGuardrail.retryBackoffMs': 100,
  'text.externalGuardrail.includeReasoning': false,
} as const;

export type TextGuardrailPostureKey = keyof typeof TEXT_GUARDRAIL_POSTURE_DEFAULTS;

type KeyMeta = { label: string; description: string; dataType: 'boolean' | 'number' };

const META: Record<TextGuardrailPostureKey, KeyMeta> = {
  'text.externalGuardrail.timeoutS': {
    label: 'Guardrail call timeout (s)',
    dataType: 'number',
    description:
      'How long TEXT waits for guardrail to answer one moderation call (the connect phase has its own short bound). ' +
      'It must outlast one guardrail validation — admission wait plus one judge attempt at ' +
      '`guardrail.judge.timeoutSeconds` — or TEXT abandons judgements guardrail is still running and they stack on ' +
      'the shared GPU. A timed-out call is not retried, so a hang costs one timeoutS; keep it below the caller-side ' +
      'request timeout that bounds it.',
  },
  'text.externalGuardrail.maxRetries': {
    label: 'Guardrail retry budget',
    dataType: 'number',
    description:
      'EXTRA attempts after the first (total tries = maxRetries + 1), spent only on failures that started no work in ' +
      'guardrail: a connection that could not be made or was dropped before any response, and an upstream ' +
      '502/503/504. A timeout is never retried (the judgement is still running). A blip is absorbed and the prompt ' +
      'proceeds on a clean re-check; a sustained outage exhausts the budget and fails closed. 0 = no retry.',
  },
  'text.externalGuardrail.retryBackoffMs': {
    label: 'Guardrail retry backoff (ms)',
    dataType: 'number',
    description:
      'Linear backoff between moderation retries: attempt N waits `N x retryBackoffMs`. Counts toward the latency ' +
      'ceiling described under the timeout.',
  },
  'text.externalGuardrail.includeReasoning': {
    label: 'Include guardrail reasoning (platform default)',
    dataType: 'boolean',
    description:
      'Whether the moderation call asks guardrail to return its reasoning. Off by default: the reasoning quotes the ' +
      'prompt, so it widens what a verdict carries back across a service boundary. Same tenant-inherits-on-absence ' +
      'semantics as the tenant half.',
  },
};

/**
 * The export name is unchanged so `registry.ts` needs no edit — its CONTENTS are
 * what moved. See the header: the eight connection keys are gone, and TEXT's
 * remaining registry surface is the platform half of the guardrail posture.
 */
export const TEXT_PROVIDER_CONNECTION_SETTINGS: SettingDescriptor[] = (
  Object.keys(TEXT_GUARDRAIL_POSTURE_DEFAULTS) as TextGuardrailPostureKey[]
).map<SettingDescriptor>((key) => ({
  key,
  // D-2: `global-kv` is the one tier with a complete read + write + cascade +
  // invalidate loop. A bespoke table for one service's posture is the failure
  // that decision exists to prevent.
  tier: 'global-kv',
  // What puts the key on `GET /internal/effective-config?service=text`. Safe
  // here because every key is PLATFORM-scope: one cached snapshot per process.
  consumedBy: ['text'],
  dataType: META[key].dataType,
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  // Tuning and inherited defaults: an unwritten row must degrade to today's
  // behaviour, not to an outage. `apps/text` mirrors this — an absent group
  // keeps the in-code floor.
  failMode: 'open-to-default',
  category: 'Guardrail Policy',
  label: META[key].label,
  description: META[key].description,
  default: TEXT_GUARDRAIL_POSTURE_DEFAULTS[key],
}));
