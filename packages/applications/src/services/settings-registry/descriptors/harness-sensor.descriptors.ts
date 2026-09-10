// Harness clinical-assurance gate thresholds — the PLATFORM defaults.
//
// These seven values decide whether a generated clinical note PASSES its assurance gate,
// is sent back for regeneration, or is escalated to a clinician. Before this they were
// pydantic-settings defaults in `apps/harness/src/harness/sensors/config.py`, retunable
// only by a redeploy — and that module's own docstring said so: *"Making these
// admin-editable (effective values resolve from the HarnessPolicy DB row) is a separate,
// coordinated change."*
//
// WHICH CHANNEL, AND WHY (owner decision D-1). The PER-TENANT lane already exists and is
// PUSH: `HarnessPolicy` resolves per tenant in this gateway, and the harness workflow
// snapshots the result onto the activity input at workflow start. What had no home at all
// was the PLATFORM DEFAULT — the value in force for a tenant with no opinion. That is
// exactly what the PULL route carries: platform scope, one cached snapshot per service
// process, TTL plus push invalidation. So the effective precedence in harness is
//
//     tenant policy (PUSH) -> these keys (PULL) -> the service's env bootstrap
//
// and registering them takes nothing away from a tenant: a policy value still wins
// outright and never reaches the resolver these feed.
//
// `maxScope: 'system'` says so structurally — a tenant tunes its gate through its OWN
// `HarnessPolicy` row, never by overriding the platform default. Putting a tenant-varying
// value on the pull route is the bug D-1 exists to prevent.
//
// DEFAULTS ARE TRANSCRIBED VERBATIM from the consuming service's current fallbacks
// (`SensorThresholds`, verified 2026-08-23), so registering them changes ZERO runtime
// behaviour: a read that misses the DB resolves to exactly the value in force today.
//
//   entityFaithfulness 1.0 zero-tolerance: any note entity ungrounded in the transcript fails
//   coverage 0.8 >= 80% of transcript entities reflected in the note
//   citationPresence 1.0 every provenance claim carries >= 1 evidence span
//   numericDose 1.0 zero-tolerance: every numeric/dose value matches the transcript
//   groundedness 0.8 >= 80% of claims entailed per the judge (graded, not exact-match)
//   citationVerify 0.8 >= 80% of CITED claims entailed by their cited chunk(s)
//   atomicFact 0.8 >= 80% of atomic claims entailed per the deterministic NLI

import { SettingDescriptor } from '../registry.types';

/**
 * The claim-check OFFLOAD THRESHOLD — how large a clinical blob must be before harness
 * writes it out-of-band instead of leaving it inline in Temporal workflow history.
 *
 * It lives here rather than in a claim-check file of its own because it is the same kind
 * of thing as the gates below: a harness TUNING number on the PULL route, platform scope,
 * `global-kv` (D-2). The SIBLING knobs (`bucket` / `endpoint` / `region`) are deliberately
 * NOT here — a storage LOCATION belongs in the existing `storage.platformDefault.*` /
 * `TenantStorageConfig` cascade, and creating a second home for it is precisely what D-2
 * forbids. Those are blocked on a `db-config` resolver for the pull route, which does not
 * exist yet (`EffectiveSettingsService.resolveEffective` handles `pipeline.*`, `models.*`
 * and `global-kv` only).
 *
 * Retunable without a redeploy on purpose: the safe value depends on how much of the
 * ~50 MB Temporal history budget a real encounter consumes, which differs per environment
 * and per workload. Default transcribed verbatim from `ClaimCheckConfig.min_bytes`.
 */
export const HARNESS_CLAIM_CHECK_MIN_BYTES: SettingDescriptor = {
  key: 'harness.claimCheck.minBytes',
  tier: 'global-kv',
  consumedBy: ['harness'],
  dataType: 'number',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  failMode: 'open-to-default',
  category: 'Clinical Assurance',
  label: 'Claim-check offload threshold (bytes)',
  description:
    'Payloads at or above this many UTF-8 bytes (transcript, assembled prompt, generated note, RAG chunks) are written to the claim-check blob store and replaced in Temporal history by a small content-addressed reference; smaller ones stay inline and pay no store round trip. Raising it keeps more content inline and grows workflow history toward its ~50 MB budget; lowering it offloads more aggressively at the cost of a round trip per field. A non-positive value is refused by the service rather than applied — it would offload every payload, including a two-word one.',
  default: 65536,
};

/** Registry key -> the consuming service's current fallback. */
export const HARNESS_SENSOR_DEFAULTS = {
  'harness.sensor.entityFaithfulnessThreshold': 1.0,
  'harness.sensor.coverageThreshold': 0.8,
  'harness.sensor.citationPresenceThreshold': 1.0,
  'harness.sensor.numericDoseThreshold': 1.0,
  'harness.sensor.groundednessThreshold': 0.8,
  'harness.sensor.citationVerifyThreshold': 0.8,
  'harness.sensor.atomicFactThreshold': 0.8,
} as const;

export type HarnessSensorKey = keyof typeof HARNESS_SENSOR_DEFAULTS;

const META: Record<HarnessSensorKey, { label: string; description: string }> = {
  'harness.sensor.entityFaithfulnessThreshold': {
    label: 'Entity faithfulness threshold',
    description:
      'Fraction of note entities that must be grounded in the transcript. ZERO-TOLERANCE at 1.0 by design: fabrication is the highest-harm documentation error, so a single ungrounded entity fails the gate. Lower it only with a clinical decision behind it — this is not a noise knob, and the FLAG-always behaviour it was once blamed for was a defect in entity cleanup, not a too-strict threshold.',
  },
  'harness.sensor.coverageThreshold': {
    label: 'Coverage (omission) threshold',
    description:
      'Fraction of transcript entities that must be reflected in the generated note. Guards OMISSION — clinically significant content discussed in the consultation but missing from the note.',
  },
  'harness.sensor.citationPresenceThreshold': {
    label: 'Citation presence threshold',
    description:
      'Fraction of provenance claims that must carry at least one evidence span. 1.0 means every claim in the note is attributable to a transcript segment.',
  },
  'harness.sensor.numericDoseThreshold': {
    label: 'Numeric / dose fidelity threshold',
    description:
      'Fraction of numeric and dose values in the note that must match the transcript. ZERO-TOLERANCE at 1.0: a transcribed dose that drifts is a medication error, not a wording difference.',
  },
  'harness.sensor.groundednessThreshold': {
    label: 'Groundedness threshold',
    description:
      'Fraction of provenance claims that must be entailed by the transcript or their evidence, per the LLM judge. Lower than the zero-tolerance checks because semantic entailment is GRADED rather than exact-match. Regen-fixable: a failure sends the note back for regeneration rather than escalating.',
  },
  'harness.sensor.citationVerifyThreshold': {
    label: 'Citation verification threshold',
    description:
      'Fraction of CITED claims that must be entailed by the knowledge chunk they cite, per the same judge — the institutional-RAG counterpart to groundedness. Regen-fixable; a judge outage degrades this sensor to an "unverified" badge rather than passing it.',
  },
  'harness.sensor.atomicFactThreshold': {
    label: 'Atomic-fact threshold',
    description:
      "Fraction of the note's atomic claims that must be entailed by the transcript per the DETERMINISTIC self-hosted NLI — a second, model-cheap groundedness gate running alongside the LLM judge. Regen-fixable; a degraded NLI backend degrades the sensor and never auto-PASSes.",
  },
};

export const HARNESS_SENSOR_SETTINGS: SettingDescriptor[] = (Object.keys(HARNESS_SENSOR_DEFAULTS) as HarnessSensorKey[]).map<SettingDescriptor>(
  (key) => ({
    key,
    // D-2: `global-kv` is the one tier with a complete read + write + cascade +
    // invalidate loop. These are not a row on `AiProviderConnection`/`AiRoutingPolicy`/
    // `AiModel`, so `db-config` does not apply and a bespoke table would be the third
    // home D-2 exists to forbid.
    tier: 'global-kv',
    // The ONLY wiring step: this is what puts the key on
    // `GET /internal/effective-config?service=harness`.
    consumedBy: ['harness'],
    dataType: 'number',
    sensitivity: 'internal',
    // Platform default only — the tenant lane is `HarnessPolicy`, not an override here.
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    // TUNING, so `open-to-default`: an unwritten row must leave harness on its bootstrap
    // value, exactly as it behaves today. Fail-closed would turn "nobody has configured
    // this yet" into an effective-config endpoint failure, which is the opposite of the
    // degradation contract every consumer of this route is built around.
    failMode: 'open-to-default',
    // A tenant may only TIGHTEN a gate. Higher is stricter here: a claim has to earn its
    // pass, so raising the fraction makes the gate harder to satisfy. Declaring the
    // direction on the descriptor is what lets ONE enforcement point in the write lane
    // cover every such key, instead of a per-feature floor function with its own key table.
    floorDirection: 'higher-is-stricter',
    category: 'Clinical Assurance',
    label: META[key].label,
    description: META[key].description,
    default: HARNESS_SENSOR_DEFAULTS[key],
  }),
);
