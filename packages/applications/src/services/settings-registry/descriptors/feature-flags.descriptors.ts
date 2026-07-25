// Feature gates — env today, `redis-flag` eventually (TASK-558 lane F).
//
// SAME HONESTY RULE AS `platform-knobs.descriptors.ts`, and here it matters even
// more: plan §3.2 lists this family under `redis-flag`, but there is currently NO
// redis-flag infrastructure at all — zero descriptors use the tier and
// `EffectiveSettingsService` has no branch for it. Declaring `tier: 'redis-flag'`
// would assert these values live in a flag store that does not exist and that
// nothing reads. Every key below is therefore `tier: 'env'` (a verified
// `process.env` / pydantic-settings read) with `targetTier: 'redis-flag'`.
//
// WHY `redis-flag` IS THE RIGHT DESTINATION (plan §9.3 M9): a kill-switch is only
// worth having if it fans out INSTANTLY. A flag that needs a redeploy is not a
// kill-switch, it is a build flag. Redis pub/sub already carries the
// `SecretsService` eviction channel, so the transport exists; the flag store on
// top of it does not yet.
//
// WHAT THE MIGRATION COSTS PER KEY: a Redis-backed read with a bounded local
// cache + eviction subscription, and — for the four Python-side flags — a route
// through the gateway's `/api/v1/internal/effective-config` rather than a second
// direct reader (plan §9.3 M7). Until that lands, `tier` stays `env`.
//
// ── DELIBERATELY NOT REGISTERED ──────────────────────────────────────────────
// `TENANT_IDP_ENABLED` — NO READER EXISTS. It is declared in `.env.example` and
// in `turbo.json#globalEnv`, and its own `.env.example` comment claims it is
// "read by the apps/api layer (@arcaai/applications TenantIdpConfigService …)".
// That comment is FALSE: a repo-wide grep across every `.ts` and `.py` finds no
// read of `TENANT_IDP_ENABLED` or any camelCase equivalent — `TenantIdpConfigService`
// never consults it. The misleading comment is very likely why lane A's dead-key
// scan missed it. Cataloging it would enshrine a flag that gates nothing; it
// belongs on the §2.3 dead-key list instead.
//
// ── KILL-SWITCH POLARITY (read before adding to this file) ───────────────────
// `killSwitch: true` carries a HARD governance invariant — `SettingsRegistry.killSwitches()`
// throws if any such descriptor defaults ON (fail-safe rollout, plan §9.3 M9). It
// therefore marks an ENFORCEMENT/engine gate that ships OFF, never a PROTECTION
// that ships ON. `harness.claimCheck.enabled` below is the second recorded
// instance of that distinction (the first is `rate-limit.enabled` in
// `platform-ops.descriptors.ts`): it defaults ON, so marking it a kill-switch
// would be both wrong and an assembly failure.

import { EDITABLE_BY_NONE, SettingDescriptor } from '../registry.types';

interface FlagSpec {
  key: string;
  label: string;
  description: string;
  /** The reader's own code default — verified against the declaring line. */
  default: boolean;
  /** Enforcement/engine gate that ships OFF. Omitted for protections that ship ON. */
  killSwitch?: boolean;
}

const FLAGS: FlagSpec[] = [
  // ── Gateway (TypeScript readers) ──────────────────────────────────────────
  {
    key: 'registration.selfSignupEnabled',
    label: 'Self-service registration',
    description:
      'Gates the public self-signup routes: `RegisterController` returns 404 (not 403) when off, so the endpoint\'s existence is not disclosed. Read via `ConfigService.getConfigValue`, which parses it as `=== "true"` — anything else is off. The admin-console proxy allowlist mirrors this gate.',
    default: false,
    killSwitch: true,
  },
  {
    key: 'entitlements.enabledDefault',
    label: 'Entitlements enforcement seed default',
    description:
      'SEED-TIME ONLY, and the only key in this file that is not a runtime gate: `seed/15-entitlements.ts` reads it to decide the value of the `entitlements.enabled` GlobalSetting row on a FRESH database. The live control plane is `entitlements.enabled` (already cataloged, tier `global-kv`, kill-switch). Its migration is therefore NOT to redis-flag but DELETION, once seeding takes its default from the descriptor instead of the environment.',
    default: false,
  },
  {
    key: 'harness.warmStartEnabled',
    label: 'Harness warm start',
    description:
      'Env FALLBACK for harness warm-start; `HarnessInternalService` treats the DB/policy value as the authority and consults this only when that is absent. Being a fallback for a policy value is itself an argument for moving it out of env.',
    default: false,
    killSwitch: true,
  },
  {
    key: 'liveDoc.groundedness.enabled',
    label: 'Live-doc groundedness gate',
    description:
      'Gates the output-side groundedness check on the live-documentation path. Read once in the `LiveDocumentationService` constructor as `=== "true"`, so a change needs a restart — the clearest instant-fan-out candidate in this file.',
    default: false,
    killSwitch: true,
  },

  // ── Python services (pydantic-settings readers) ───────────────────────────
  {
    key: 'guardrailV2.groundedness.enabled',
    label: 'Guardrail groundedness gate',
    description:
      'Gates the guardrail NLI groundedness gate (`GUARDRAIL_V2_GROUNDEDNESS_` prefix). OFF is the dev/hermetic-CI bypass: the gate answers honestly with `unverified` and never loads a model. Fail posture is FAIL-CLOSED throughout — a disabled gate, an un-staged model and a scoring error all degrade to `unverified`, and no path yields `grounded` without the model actually entailing the segment. Turning it ON requires the self-hosted MiniCheck-class model staged on the host (no cloud PHI).',
    default: false,
    killSwitch: true,
  },
  {
    key: 'smr.externalGuardrail.enabled',
    label: 'SMR input moderation',
    description:
      'Gates input moderation on SMR `/generate` (`SMR_EXTERNAL_GUARDRAIL_` prefix). OFF is the dev/CI bypass so local runs need no guardrail service. When ON the posture is fail-CLOSED by construction: a transient error is absorbed by a bounded retry, a sustained outage rejects, and an errored guardrail NEVER allows — there is deliberately no `fail_open` option.',
    default: false,
    killSwitch: true,
  },
  {
    key: 'harness.nerPriorsEnabled',
    label: 'Harness NER priors reuse',
    description:
      'Gates reuse of already-persisted CODED NER priors inside harness activities. A workflow-policy value may override it per run; this is the fallback when the policy says nothing.',
    default: false,
    killSwitch: true,
  },
  {
    key: 'harness.atomicFactEnabled',
    label: 'Harness atomic-fact sensors',
    description: 'Gates the `run_inferential_sensors` atomic-fact path. Same policy-overrides-env shape as the NER-priors flag.',
    default: false,
    killSwitch: true,
  },
  {
    key: 'semanticEndpoint.enabled',
    label: 'STT semantic endpointing',
    description:
      'Gates content-driven semantic end-of-utterance detection on the STT streaming hot path. NOTE the naming exception: the STT `Settings` class carries NO `env_prefix`, so this is the BARE `SEMANTIC_ENDPOINT_ENABLED`, not `STT_SEMANTIC_ENDPOINT_ENABLED` — one of the plan §3.3 rule-1 violations (prefix must equal the service prefix) that a later rename has to fix. Default OFF until measured against the accuracy/latency scorecard.',
    default: false,
    killSwitch: true,
  },
  {
    key: 'harness.claimCheck.enabled',
    label: 'Harness claim-check offload',
    description:
      'Moves large clinical blobs OUT of Temporal workflow history into a self-hosted content-addressed store, protecting the ~50 MB history budget. ' +
      'DEFAULTS **ON**, and is therefore NOT marked `killSwitch` — it is a PROTECTION, so turning it off REMOVES a safeguard (unbounded history growth) rather than disabling an enforcement path. Marking it a kill-switch would violate the defaults-OFF invariant and fail registry assembly. Same polarity as `rate-limit.enabled`. ' +
      'Turning it off is a deliberate acceptance of unbounded Temporal history, exactly as the harness startup validator states.',
    default: true,
  },
];

export const FEATURE_FLAG_SETTINGS: SettingDescriptor[] = FLAGS.map<SettingDescriptor>((flag) => ({
  key: flag.key,
  tier: 'env',
  targetTier: 'redis-flag',
  dataType: 'boolean',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: EDITABLE_BY_NONE,
  // A flag whose value cannot be read must behave as it does today: the reader's
  // own code default. Every default below is the SAFE end of its flag, so
  // open-to-default never silently enables anything (plan §9.3 M5/M9).
  failMode: 'open-to-default',
  ...(flag.killSwitch ? { killSwitch: true } : {}),
  category: 'Feature Flags',
  label: flag.label,
  description: flag.description,
  default: flag.default,
}));
