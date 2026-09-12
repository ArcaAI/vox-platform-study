// TASK-959 — which DEVICE each self-hosted LLM server runs on.
//
// ## What this key decides
//
// Compute metering records the seconds a request OCCUPIED a model, and the unit
// it records them in depends on the device: `cuda`/`mps` → `GPU_SECOND`, `cpu` →
// `CPU_SECOND`. The two are priced an order of magnitude apart (the seeded
// placeholders are ~$1.98/GPU-hour against ~$0.036/vCPU-hour), so this is not a
// label — it selects a rate.
//
// Every OTHER service can answer the question itself: stt resolves the device
// per process (`execution_profile.py`, `LoadedModel.device`), tts and nlp from
// their own settings. `apps/text` cannot. There is no `device` field on
// `ProviderOverride`, on `GenerateRequest`, or on `AiModel` — `computeType` is a
// PRECISION (fp16/int8), not a device — and the service is stateless per call,
// so it does not know what hardware the server it just posted to is using. For
// the LLM engines the device is therefore SUPPLIED by configuration, and this is
// where it is supplied from.
//
// ## Why `open-to-default`, resolving to `cpu`
//
// A provider with no entry must record the CHEAPER unit, never nothing.
// Fail-closed would make a missing entry raise on the EMITTING path, which
// would lose the whole usage batch — tokens included — to protect a device
// label; that trades real revenue for an accounting detail. Under-recording is
// the correctable direction: a mis-set entry shows up on the consumption screen
// as an implausible CPU figure, and a compensating event fixes history. This is
// a stated R1 blind spot (ticket §3.5), not a hidden one.
//
// ## Why the tier is `global-kv` and not `db-config`
//
// The ticket's §3.1 says `db-config`. That tier cannot deliver the SYSTEM
// default + tenant override the same sentence asks for, and both halves were
// verified against the code on this branch:
//
//   1. READ. `EffectiveSettingsService.resolveEffective` dispatches `db-config`
//      per key FAMILY, and the only family with a lane is platform storage
//      (`PLATFORM_STORAGE_KEYS`). Every other `db-config` key falls through to
//      `throw new ArgumentInvalidException("No effective resolver is registered
//      for setting …")` — so the first emitter to resolve it would 400.
//   2. WRITE. `SettingsRegistryWriteService` refuses every tier but `global-kv`
//      ("Tier 'db-config' is not writable through the registry lane"), so no
//      tenant admin could ever set the override this key exists to provide.
//
// `global-kv` delivers exactly the declared semantics: `TenantSettingsService
// .resolve` walks tenant override → SYSTEM row → descriptor default and reports
// which tier answered. `user-identity.descriptors.ts` took the same deviation
// for TASK-950 D-9, for the same two reasons.
//
// ## Its own file, not `metering.descriptors.ts`
//
// Every key in that file is `globalOnly` platform plumbing at
// `maxScope: 'system'` — job schedules and kill-switches a tenant admin must
// never see. This one is the opposite: `maxScope: 'tenant'`, deliberately
// tenant-visible (`isTenantVisibleSetting`), because a tenant that brings its
// own self-hosted server is the only party who knows what that server runs on.

import { SettingDescriptor } from '../registry.types';
import { COMPUTE_DEVICES, type ComputeDevice } from '../../usageLedger/usage-attributes';
import { validateProviderId } from '../../usageLedger/vocabulary';

/** Server-side taxonomy bucket. The first tenant-visible metering key. */
export const METERING_COMPUTE_CATEGORY = 'Metering';

export const COMPUTE_DEVICE_BY_PROVIDER_KEY = 'metering.compute.deviceByProvider';

/**
 * The platform's answer for the four self-hosted LLM servers HOPE ships an
 * adapter for.
 *
 * GPU for the three that are deployed on a GPU node, `cpu` for llama.cpp, which
 * is the CPU-inference engine in the set. Absent from the map ⇒ `cpu`, so this
 * default only ever needs to name the providers that are NOT CPU — llama-cpp is
 * listed anyway, because "decided to be CPU" and "nobody said" are different
 * facts and only one of them is worth an admin's attention.
 *
 * The keys are spelled exactly as `KNOWN_PROVIDERS` spells them (`lm-studio`,
 * `llama-cpp` — hyphenated). `lmstudio` here would never match, so every call
 * would fall back to `cpu` while the admin screen showed a GPU entry.
 */
export const COMPUTE_DEVICE_BY_PROVIDER_DEFAULT: Readonly<Record<string, ComputeDevice>> = {
  'lm-studio': 'cuda',
  vllm: 'cuda',
  ollama: 'cuda',
  'llama-cpp': 'cpu',
};

/**
 * Both halves of every entry, checked against the vocabularies that will be
 * applied downstream anyway.
 *
 * The device is checked against `COMPUTE_DEVICES` — the SAME constant
 * `validateUsageAttributes` enforces on `attributesJson.device` — so a value
 * accepted here can never be rejected at emit time, after it has already
 * chosen the unit. The provider id is checked against `validateProviderId`, the
 * canonical ledger shape, because an entry that cannot match a provider id is
 * WORSE than no entry: the admin believes the device is set and every call is
 * quietly metered as the cheap unit.
 *
 * Reports every bad entry, not the first, so a hand-edited map is fixed in one
 * pass rather than one round trip per typo.
 */
function validateDeviceByProvider(value: unknown): string | void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${COMPUTE_DEVICE_BY_PROVIDER_KEY} must be a JSON object mapping a provider id to one of: ${COMPUTE_DEVICES.join(', ')}.`;
  }

  const problems: string[] = [];

  for (const [provider, device] of Object.entries(value as Record<string, unknown>)) {
    const idViolations = validateProviderId(provider);
    if (idViolations.length > 0) {
      problems.push(`provider key "${provider}": ${idViolations.join('; ')}`);
      continue;
    }
    if (typeof device !== 'string' || !(COMPUTE_DEVICES as readonly string[]).includes(device)) {
      problems.push(`provider "${provider}" must map to one of: ${COMPUTE_DEVICES.join(', ')} (got ${JSON.stringify(device)})`);
    }
  }

  if (problems.length > 0) {
    return `${COMPUTE_DEVICE_BY_PROVIDER_KEY} is invalid — ${problems.join(' | ')}.`;
  }
}

export const METERING_COMPUTE_SETTINGS: SettingDescriptor[] = [
  {
    key: COMPUTE_DEVICE_BY_PROVIDER_KEY,
    tier: 'global-kv',
    dataType: 'json',
    sensitivity: 'internal',
    // A tenant running its own self-hosted server is the only party who knows
    // what that server runs on, so the tenant may override; the SYSTEM row is
    // the platform's answer for every tenant with no opinion.
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    // NOT a kill-switch: it selects a unit, it does not gate enforcement. And
    // NOT `consumedBy` anything — a tenant-scoped key must never ride the
    // platform-scope pull route (D-1), and the readers are the gateway's own
    // TypeScript emitters, not a Python process.
    failMode: 'open-to-default',
    category: METERING_COMPUTE_CATEGORY,
    label: 'Compute metering — device per self-hosted provider',
    description:
      'Which device each self-hosted LLM server runs on, deciding whether its occupancy seconds are metered as GPU_SECOND (cuda, mps) or CPU_SECOND (cpu). Only the LLM engines need this: stt, tts and nlp report their own device, while apps/text is stateless per call and has no device field on any request or model row to report one from. A provider ABSENT from this map resolves to cpu — the cheaper unit, never nothing — so a missing entry under-records rather than losing the usage batch. Cloud and BYOK calls ignore the map entirely: their CPU_SECOND row is the platform CPU spent CALLING the vendor and is always cpu. Keys must be spelled as the ledger spells them (lm-studio, llama-cpp).',
    default: COMPUTE_DEVICE_BY_PROVIDER_DEFAULT,
    validate: validateDeviceByProvider,
  },
];
