// Feature gates — env today, `global-kv` eventually.
//
// ── THE `redis-flag` DECISION, SETTLED ───────────────────────────────────────
// Classification recorded `targetTier: 'redis-flag'` here from the original
// taxonomy, and at the same time recorded that NO redis-flag infrastructure
// exists: zero descriptors use the tier and `EffectiveSettingsService` has no
// branch for it. That question is now closed rather than left open — the
// destination is **`global-kv`**, not a new tier, and every `targetTier` below
// now says so.
//
// The reason is that the ONLY property `redis-flag` was wanted for is instant
// fan-out ("a flag that needs a redeploy is not a kill-switch, it is a
// build flag") — and `global-kv` already has it. `AppSettingsService` publishes
// on `app-settings:invalidate` after every `GlobalSetting` write and subscribes
// to it on init, so a peer node drops and reloads its cache on push; the 45s
// cron is the backstop, not the mechanism (proved end to end).
// Building a second flag store on the same Redis to get a property the first
// one already has would be new infrastructure bought with no new capability —
// plus a second write path, a second invalidation contract, and a second place
// for a flag to be stale. `platform-knobs.descriptors.ts` shows the shape a
// migrated key takes.
//
// WHAT THE MIGRATION STILL COSTS PER KEY: moving the READER. That is what
// `tier` tracks, and it is why the flags below have NOT flipped: six of the ten
// are read by pydantic-settings inside a Python service, so their migration is
// a `/api/v1/internal/effective-config` route on the gateway plus a change in
// that service's `config.py` — files this catalog does not own (they belong to
// the Python-loader path). Flipping `tier` while a `process.env` read is still the
// authority would make the catalog LIE, which is the one thing the honesty rule
// below forbids.
//
// ── DELIBERATELY NOT REGISTERED ──────────────────────────────────────────────
// `TENANT_IDP_ENABLED` — NO READER EXISTS. It is declared in `.env.sample` and
// in `turbo.json#globalEnv`, and its own `.env.sample` comment claims it is
// "read by the apps/api layer (@arcaai/applications TenantIdpConfigService …)".
// That comment is FALSE: a repo-wide grep across every `.ts` and `.py` finds no
// read of `TENANT_IDP_ENABLED` or any camelCase equivalent — `TenantIdpConfigService`
// never consults it. The misleading comment is very likely why the dead-key
// scan missed it. Cataloging it would enshrine a flag that gates nothing; it
// belongs on the dead-key list instead.
//
// ── KILL-SWITCH POLARITY (read before adding to this file) ───────────────────
// `killSwitch: true` carries a HARD governance invariant — `SettingsRegistry.killSwitches()`
// throws if any such descriptor defaults ON (fail-safe rollout). It
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
      'SEED-TIME ONLY, and the only key in this file that is not a runtime gate: `seed/15-entitlements.ts` reads it to decide the value of the `entitlements.enabled` GlobalSetting row on a FRESH database. POLICY (TASK-638): quota enforcement is ON in every DEPLOYED environment (hope-v2-dev, staging, production) — each sets ENTITLEMENTS_ENABLED_DEFAULT=true in its host env / deploy overlay — and OFF only in LOCAL development (this committed default) and test/CI (never set), so a developer never fights quota locally and the shared E2E baseline stays deterministic. Keep this LOCAL default false; an operator flips it live via `PUT /admin/entitlements/enabled`. The live control plane is `entitlements.enabled` (already cataloged, tier `global-kv`, kill-switch). Its migration is therefore NOT to redis-flag but DELETION, once seeding takes its default from the descriptor instead of the environment.',
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
  // Corrected from `redis-flag` — see the header. The destination is
  // the EXISTING `global-kv` tier, whose `app-settings:invalidate` fan-out
  // already delivers the instant propagation `redis-flag` was wanted for.
  targetTier: 'global-kv',
  dataType: 'boolean',
  sensitivity: 'internal',
  // Stays `system` until the reader moves: a governance test binds
  // `tier: 'env'` to `maxScope: 'system'` (an env var has no cascade), and
  // tenant scope for the harness/groundedness toggles is a
  // property of the DB tier they are headed for, not of the env read.
  maxScope: 'system',
  editableBy: EDITABLE_BY_NONE,
  // A flag whose value cannot be read must behave as it does today: the reader's
  // own code default. Every default below is the SAFE end of its flag, so
  // open-to-default never silently enables anything.
  failMode: 'open-to-default',
  ...(flag.killSwitch ? { killSwitch: true } : {}),
  category: 'Feature Flags',
  label: flag.label,
  description: flag.description,
  default: flag.default,
}));
