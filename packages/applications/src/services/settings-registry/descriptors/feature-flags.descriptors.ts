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
    key: 'workflowExposure.enabled',
    label: 'Workflow exposure plane (public invoke)',
    description:
      "R-1 kill-switch for the whole `/api/v1/workflows/:slug/…` public-invoke surface. Design.md's precondition: API-key scope enforcement must be verified end-to-end before this ships enabled; Temporal is also not yet production-ready (R-2). Read via `ConfigService.getConfigValue('WORKFLOW_EXPOSURE_ENABLED')`, `=== \"true\"` — a 404 (existence not disclosed) while off, same posture as `registration.selfSignupEnabled`.",
    default: false,
    killSwitch: true,
  },
  // `workflowExposure.allowCloudProviders` (decision #6, R-8) REMOVED by owner decision
  // (2026-08-20): a publicly-exposed workflow MAY select a cloud AI provider — the
  // tenant carries the risk (BYOK), consistent with the platform's BYO-first posture.

  // `entitlements.enabledDefault` was declared here, and its own description
  // named the exit: "its migration is DELETION". TASK-872 took it, together
  // with the sibling `metering.reconcile.enabledDefault`
  // (metering.descriptors.ts).
  //
  // The seed does NOT read these descriptors — `seed/15-entitlements.ts` reads
  // `process.env.ENTITLEMENTS_ENABLED_DEFAULT` as an explicit OVERRIDE over its
  // own derived default (`seedsEnforcementOn()`), so seeding is unchanged and
  // the override still works from host env. What the descriptor did was emit
  // `ENTITLEMENTS_ENABLED_DEFAULT=false` into the generated `.env.sample` —
  // and since `pnpm setup:dev` copies that file to `.env.dev`, it FORCED
  // enforcement off on every laptop, reversing the 2026-08-22 owner decision
  // that local dev runs with enforcement ON. A stale declaration that beats the
  // code it documents is worse than no declaration.
  // `harness.warmStartEnabled`, `harness.nerPriorsEnabled` and `harness.atomicFactEnabled` were
  // here as env FALLBACKS for three SUPER_ADMIN_ONLY `HarnessPolicy` columns of the same name.
  // TASK-882 removed them: the column is the one source, a null column is the code default
  // (OFF), and no reader — TS or Python — consults an env variable for them any more.
  {
    key: 'liveDoc.groundedness.enabled',
    label: 'Live-doc groundedness gate',
    description:
      'Gates the output-side groundedness check on the live-documentation path. Read once in the `LiveDocumentationService` constructor as `=== "true"`, so a change needs a restart — the clearest instant-fan-out candidate in this file.',
    default: false,
    killSwitch: true,
  },

  // ── Python services (pydantic-settings readers) ───────────────────────────
  // `guardrailV2.groundedness.enabled` (env tier, `GUARDRAIL_V2_GROUNDEDNESS_`
  // prefix) was declared here. TASK-872 removed it: guardrail's
  // `GroundednessConfig` holds no env-reachable field at all any more, so
  // `GUARDRAIL_V2_GROUNDEDNESS_ENABLED` reaches no pydantic field and appears
  // in no Python surface manifest. The LIVE gate is
  // `guardrail.groundedness.enabled` (`service-runtime.descriptors.ts`, tier
  // `global-kv`, `consumedBy: ['guardrail']`), served on the pull route — this
  // one was the env-era twin left behind after that migration.
  // `text.externalGuardrail.enabled` MOVED to `text-provider-connections.descriptors.ts`.
  // This family is uniformly `tier: 'env'` — every flag here
  // is still read from a process environment variable — and
  // `TEXT_EXTERNAL_GUARDRAIL_ENABLED` no longer exists, so leaving it would have
  // left a phantom declaration that `pnpm env:sync --check` exists to catch. It
  // is a `global-kv` kill-switch now, served on the effective-config PULL route
  // alongside the rest of TEXT's moderation posture, so turning moderation on
  // for a clinical deployment takes effect on the next request rather than the
  // next restart.
  // `semanticEndpoint.enabled` (bare `SEMANTIC_ENDPOINT_ENABLED`) was here — the
  // eighth duplicate of the `stt.semanticEndpoint.*` family. TASK-877 deleted its
  // only reader, the `Settings.semantic_endpoint_enabled` field, so nothing reads
  // this flag any more; removed completely rather than left dual-homed, same as
  // the other seven (see `stt-runtime.descriptors.test.ts`).
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
