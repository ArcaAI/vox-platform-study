// Guardrail policy descriptors (TASK-735 Phase 4).
//
// Turns the values `apps/guardrail/src/guardrail/core/config.py` and
// `providers/gliner.py` currently hardcode into governed `SettingDescriptor`s —
// tier `db-config`, tenant → SYSTEM cascade, mirroring `models.guardrail.*`
// (`model-defaults.descriptors.ts`) and `stt.fallback.*`
// (`stt-fallback.descriptors.ts`). This file owns POLICY (thresholds, judge
// tuning, groundedness tuning, label taxonomies) — it does NOT own model
// SELECTION (`models.guardrail.*`, another lane's file) or the Granite BYOC
// criteria strings, which decision D5 puts in the PromptTemplate plane
// (versioned, approval-gated) rather than here — see "Out of scope" below.
//
// Source values (verified 2026-08-16 against the files above):
//   GlinerConfig.classification_threshold      0.4    core/config.py:168
//   GlinerConfig.pii_threshold                 0.5    core/config.py:169
//   OllamaConfig/OpenAICompatConfig
//     .guardian_min_confidence                 0.75   core/config.py:50,94
//     .temperature                             0.1    core/config.py:44,88
//     .max_tokens                              500    core/config.py:45,89
//     .timeout_s                               60     core/config.py:39,83
//   GroundednessConfig.entailment_threshold    0.5    core/config.py:224
//   GroundednessConfig.batch_size              16     core/config.py:227
//   GroundednessConfig.max_segments            200    core/config.py:231
//   SAFETY_LABELS / PII_LABELS / ADVERSARIAL_LABELS / HARMFUL_LABELS
//                                                      providers/gliner.py:21-71
//
// ── failMode split (owner rule: closed decides a verdict, open-to-default tunes) ──
//
// `classificationThreshold` / `piiThreshold` / `guardianMinConfidence` /
// `entailmentThreshold` and all four label taxonomies are `failMode: 'closed'`:
// each one is consulted DIRECTLY by the safe/unsafe, PII/not-PII, or
// grounded/unverified decision. An unresolved threshold or taxonomy must
// never silently substitute a default — that would let a policy gap through
// disguised as "today's behaviour", exactly the class of mistake
// `models.*` selection is already closed against (`tenant_config.py`:
// "the caller must not fall back to env for provider/model selection").
//
// `judgeTemperature` / `judgeMaxTokens` / `judgeTimeoutSeconds` /
// `groundednessBatchSize` / `groundednessMaxSegments` are `failMode:
// 'open-to-default'`: none of them individually decides safe/unsafe or
// grounded/unverified.
//   - temperature/max_tokens shape the judge's OUTPUT, not the threshold that
//     later interprets it — the verdict-deciding fields above still gate the
//     outcome regardless of what the judge said.
//   - timeout_s: exhausting the budget already fails CLOSED to
//     `allowed: False` (Phase 2 §2 of the ticket) — a SHORTER timeout makes
//     the safe path MORE likely to trigger, not less, so it is not something
//     a tenant could "loosen" by raising it. Latency/availability tuning only.
//   - batch_size is a pure throughput lever over the same per-segment
//     `entailmentThreshold` check — it changes how fast segments are scored,
//     never what counts as grounded.
//   - max_segments bounds how many segments get scored at all; segments past
//     the cap degrade to `unverified` (the conservative outcome) rather than
//     being silently treated as grounded, so raising it only means MORE
//     segments receive a real entailment check, which cannot weaken the gate.
// A missing row for any of these five must degrade to today's behaviour, not
// turn a judge/groundedness call into an outage.
//
// ── Tighten-only floor (decision D2) ──
//
// A tenant may only move a verdict-deciding key TOWARDS more safety relative
// to the platform floor (the resolved SYSTEM row, or the code default absent
// one) — never away from it. `assertGuardrailPolicyFloor` is the ONE place
// that direction is expressed and enforced: it REJECTS a looser tenant value
// with `GuardrailPolicyFloorViolation` (403 — a privilege boundary, not the
// 404-over-403 cross-tenant posture and not a silent clamp, per D2 verbatim).
// This is deliberately NOT `tenant-clamp.ts`'s `clampTenantSetting`: that
// helper silently substitutes the bound and reports `clamped: true`, which is
// the exact behaviour D2 rules out for a safety floor. The five tuning keys
// carry no entry in `GUARDRAIL_POLICY_FLOOR_DIRECTIONS`, so
// `assertGuardrailPolicyFloor` is a no-op for them — nothing about them
// decides a verdict, so there is nothing to floor.
//
// `entitlement`-tier interaction (a plan-tiered floor tighter than the
// platform SYSTEM row, the way `TENANT_OVERRIDE_CLAMPS` layers an
// entitlement ceiling on top of the platform bound for `rateLimit.*`) is a
// natural extension but is NOT built here: `tenant-clamp.ts`'s entitlement
// bound is a MAXIMUM by construction and only participates in its
// `lower-is-stricter` direction, whereas half of this file's keys are
// `higher-is-stricter` — wiring that in needs a change to shared clamp
// infrastructure this lane does not own. Left as a follow-up.
//
// ── Out of scope ──
//
// The Granite BYOC criteria strings and the `<guardian>` template
// (`providers/_granite.py:19-43`) are NOT descriptors here (decision D5):
// they decide a clinical verdict via free-text criteria, which needs version
// control and an approval gate, not a scalar/array setting. A future
// PromptTemplate-backed criteria set for guardrail would need: a
// `PromptTemplate` category dedicated to guardrail judge criteria (mirroring
// how `text.finalize`/`text.test` already resolve a template tenant-first), a
// SYSTEM-authored default template seeded at the platform floor, and the same
// tighten-only posture this file gives thresholds — a tenant-authored
// criteria template would need review against the SYSTEM template rather
// than being accepted verbatim, or a tenant could quietly narrow what the
// judge screens for. Not built here; noted for whoever picks up D5.
//
// `models.guardrail.validate` / `.safety` / `.groundedness`
// (`model-defaults.descriptors.ts`, owned by another lane this session) stay
// separate: those select WHICH model runs, gated by the
// `featureGuardrailModelSelection` entitlement (Phase 0, also owned
// elsewhere). This file's keys are independent of that entitlement — a
// tenant tightening `piiThreshold` needs no model-selection grant, and
// nothing here reads or requires `featureGuardrailModelSelection`.

import { ForbiddenException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { walkCascade } from '../scope-cascade';
import { SettingDescriptor } from '../registry.types';

/** Canonical dotted-key namespace for every descriptor in this file. */
const GUARDRAIL_POLICY_KEY_PREFIX = 'guardrail.policy.';

/**
 * Code defaults, transcribed verbatim from `config.py`/`gliner.py` (see the
 * source table above) so registering these keys changes ZERO runtime
 * behaviour — a read that misses the DB resolves to exactly today's value
 * for the five `open-to-default` tuning keys. The four `closed` threshold
 * keys and four `closed` taxonomy keys keep their values here too (as the
 * SYSTEM-row seed value a future migration plants), but — matching
 * `models.guardrail.*`'s convention for other `failMode: 'closed'`
 * descriptors — are NOT copied onto `SettingDescriptor.default`, since a
 * closed descriptor's `default` is never consulted (`resolveGuardrailPolicyValue`
 * throws before reaching it).
 */
export const GUARDRAIL_POLICY_DEFAULTS = {
  classificationThreshold: 0.4,
  piiThreshold: 0.5,
  guardianMinConfidence: 0.75,
  entailmentThreshold: 0.5,
  judgeTemperature: 0.1,
  judgeMaxTokens: 500,
  judgeTimeoutSeconds: 60,
  groundednessBatchSize: 16,
  groundednessMaxSegments: 200,
  safetyLabels: ['safe', 'unsafe'],
  piiLabels: [
    'person',
    'first_name',
    'last_name',
    'email',
    'phone',
    'address',
    'city',
    'country',
    'card_number',
    'bank_account',
    'crypto_wallet',
    'passport',
    'national_id',
    'date_of_birth',
  ],
  adversarialLabels: [
    'jailbreak_persona',
    'jailbreak_hypothetical',
    'jailbreak_roleplay',
    'prompt_injection',
    'indirect_prompt_injection',
    'instruction_override',
    'data_exfiltration',
    'system_prompt_extraction',
    'context_manipulation',
    'token_manipulation',
    'tool_abuse',
    'social_engineering',
    'multi_turn_escalation',
    'schema_poisoning',
    'none',
  ],
  harmfulLabels: [
    'harassment',
    'hate_speech',
    'discrimination',
    'violence',
    'dangerous_instructions',
    'weapons',
    'sexual_content',
    'child_exploitation',
    'fraud',
    'scam',
    'misinformation',
    'none',
  ],
} as const;

export type GuardrailPolicyShortKey = keyof typeof GUARDRAIL_POLICY_DEFAULTS;

/** The full registry key for a short key, e.g. `piiThreshold` → `guardrail.policy.piiThreshold`. */
export type GuardrailPolicyKey = `${typeof GUARDRAIL_POLICY_KEY_PREFIX}${GuardrailPolicyShortKey}`;

function toRegistryKey(short: GuardrailPolicyShortKey): GuardrailPolicyKey {
  return `${GUARDRAIL_POLICY_KEY_PREFIX}${short}`;
}

/** The five pure-tuning keys — `open-to-default`, no verdict, no floor. */
const TUNING_KEYS: readonly GuardrailPolicyShortKey[] = [
  'judgeTemperature',
  'judgeMaxTokens',
  'judgeTimeoutSeconds',
  'groundednessBatchSize',
  'groundednessMaxSegments',
];

function failModeFor(key: GuardrailPolicyShortKey): 'closed' | 'open-to-default' {
  return TUNING_KEYS.includes(key) ? 'open-to-default' : 'closed';
}

function dataTypeFor(key: GuardrailPolicyShortKey): SettingDescriptor['dataType'] {
  return Array.isArray(GUARDRAIL_POLICY_DEFAULTS[key]) ? 'string[]' : 'number';
}

/**
 * Which direction is STRICTER for each verdict-deciding key — the same
 * vocabulary as `tenant-clamp.ts`'s `ClampDirection`, plus `superset-is-stricter`
 * for the label taxonomies (a tenant may only ADD detection categories, never
 * drop a platform-mandated one). Absent from this table ⇒ no floor: either the
 * key is a tuning knob (see `TUNING_KEYS`), or it decides nothing on its own.
 *
 *  - `classificationThreshold` / `piiThreshold`: GLiNER flags a label only
 *    when its score is >= the threshold (`gliner.py` `_sync_analyze`/
 *    `_sync_extract_pii`), so a LOWER number catches MORE content — stricter.
 *  - `guardianMinConfidence` / `entailmentThreshold`: both gate a POSITIVE
 *    claim (the judge's verdict is trustworthy; a segment is `grounded`), so
 *    a HIGHER number makes that claim harder to earn — stricter.
 */
export const GUARDRAIL_POLICY_FLOOR_DIRECTIONS: Readonly<
  Partial<Record<GuardrailPolicyShortKey, 'lower-is-stricter' | 'higher-is-stricter' | 'superset-is-stricter'>>
> = Object.freeze({
  classificationThreshold: 'lower-is-stricter',
  piiThreshold: 'lower-is-stricter',
  guardianMinConfidence: 'higher-is-stricter',
  entailmentThreshold: 'higher-is-stricter',
  safetyLabels: 'superset-is-stricter',
  piiLabels: 'superset-is-stricter',
  adversarialLabels: 'superset-is-stricter',
  harmfulLabels: 'superset-is-stricter',
});

interface KeyMeta {
  label: string;
  description: string;
}

const META: Record<GuardrailPolicyShortKey, KeyMeta> = {
  classificationThreshold: {
    label: 'Content-safety classification threshold',
    description:
      'Minimum GLiNER confidence score (0-1) for a harmful/adversarial label to be flagged. LOWER catches more content — ' +
      'stricter. A tenant may only LOWER this relative to the platform floor; raising it above the floor would let riskier ' +
      'content pass undetected and is rejected as a privilege violation, not silently clamped.',
  },
  piiThreshold: {
    label: 'PII detection threshold',
    description:
      'Minimum GLiNER confidence score (0-1) for an extracted entity to be treated as PII and redacted. LOWER catches more ' +
      'entities — stricter. A tenant may only LOWER this relative to the platform floor.',
  },
  guardianMinConfidence: {
    label: 'Guardian minimum confidence',
    description:
      'Minimum confidence (0-1) the medical-context judge must report before its verdict is trusted. HIGHER makes that ' +
      'trust harder to earn — stricter. A tenant may only RAISE this relative to the platform floor.',
  },
  entailmentThreshold: {
    label: 'Groundedness entailment threshold',
    description:
      'Minimum NLI entailment score (0-1) for a generated segment to be marked `grounded` rather than `unverified`. HIGHER ' +
      'makes `grounded` harder to earn — stricter. A tenant may only RAISE this relative to the platform floor.',
  },
  judgeTemperature: {
    label: 'Judge sampling temperature',
    description:
      'Sampling temperature for the delegated LLM-judge call (`text POST /generate/internal/judge`). Tuning only — the ' +
      'thresholds above still gate the verdict regardless of what the judge produces.',
  },
  judgeMaxTokens: {
    label: 'Judge max response tokens',
    description: 'Token ceiling for the delegated judge call`s response. Tuning only; does not change what counts as a violation.',
  },
  judgeTimeoutSeconds: {
    label: 'Judge call timeout (s)',
    description:
      'How long guardrail waits for the delegated judge call before treating it as exhausted. An exhausted budget already ' +
      'fails CLOSED to `allowed: False`, so shortening this cannot weaken the safety posture — it only trades availability ' +
      'for latency.',
  },
  groundednessBatchSize: {
    label: 'Groundedness scorer batch size',
    description:
      'Segments per NLI scorer batch — the throughput lever for the groundedness gate. Pure tuning over the same `entailmentThreshold` check.',
  },
  groundednessMaxSegments: {
    label: 'Groundedness max segments per request',
    description:
      'Hard cap on segments scored in one groundedness pass. Segments beyond the cap degrade to `unverified` (never ' +
      'silently treated as grounded), so raising this only means more segments receive a real entailment check.',
  },
  safetyLabels: {
    label: 'Safety classification labels',
    description:
      'The safe/unsafe label set GLiNER classifies content against. A tenant may ADD categories but may never drop one the ' +
      'platform floor requires — an attempt to narrow the set is rejected as a privilege violation, not silently clamped.',
  },
  piiLabels: {
    label: 'PII entity labels',
    description:
      'The PII entity types GLiNER extracts for redaction. A tenant may ADD entity types but may never drop one the platform floor requires.',
  },
  adversarialLabels: {
    label: 'Adversarial/prompt-injection labels',
    description:
      'The jailbreak/prompt-injection category set GLiNER screens for. A tenant may ADD categories but may never drop one the platform floor requires.',
  },
  harmfulLabels: {
    label: 'Harmful-content labels',
    description:
      'The harmful-content category set GLiNER screens for. A tenant may ADD categories but may never drop one the platform floor requires.',
  },
};

export const GUARDRAIL_POLICY_SETTINGS: SettingDescriptor[] = (
  Object.keys(GUARDRAIL_POLICY_DEFAULTS) as GuardrailPolicyShortKey[]
).map<SettingDescriptor>((short) => {
  const failMode = failModeFor(short);
  return {
    key: toRegistryKey(short),
    tier: 'db-config',
    dataType: dataTypeFor(short),
    sensitivity: 'internal',
    // Tenant-editable per Phase 0's governance flip (D2 presupposes a tenant
    // write path): the tenant row may TIGHTEN, enforced by
    // `assertGuardrailPolicyFloor`, not by capping maxScope at 'system'.
    maxScope: 'tenant',
    editableBy: 'GuardrailPolicy',
    failMode,
    category: 'Guardrail Policy',
    label: META[short].label,
    description: META[short].description,
    ...(failMode === 'open-to-default' ? { default: GUARDRAIL_POLICY_DEFAULTS[short] } : {}),
  };
});

const GUARDRAIL_POLICY_BY_KEY = new Map(GUARDRAIL_POLICY_SETTINGS.map((d) => [d.key, d] as const));

function getGuardrailPolicyDescriptor(key: GuardrailPolicyKey): SettingDescriptor {
  const descriptor = GUARDRAIL_POLICY_BY_KEY.get(key);
  if (!descriptor) {
    throw new ArgumentInvalidException(`Unknown guardrail policy setting '${key}'.`);
  }
  return descriptor;
}

// ─────────────────────────── Resolution (pure) ───────────────────────────

export type GuardrailPolicySourceScope = 'tenant' | 'system' | 'code-default';

export interface GuardrailPolicyRow {
  /** The tenant's own row for this key, if one is stored. */
  tenantValue?: unknown;
  /** The SYSTEM/platform row for this key, if one is stored. */
  systemValue?: unknown;
}

export interface ResolvedGuardrailPolicyValue {
  key: GuardrailPolicyKey;
  value: unknown;
  source: GuardrailPolicySourceScope;
}

/**
 * The cascade THIS ticket requires: tenant row → SYSTEM row → declared
 * failure mode. Built on the shared, dependency-free `walkCascade` primitive
 * (`../scope-cascade`) so the walk itself cannot drift from every other
 * registry-driven resolver; only the fail-mode dispatch is local to this file
 * (importing the canonical `applyDeclaredFailMode` from
 * `tenant-settings.service.ts` would close a cycle back through `registry.ts`,
 * which this descriptors file is imported BY).
 *
 * `failMode: 'closed'` keys (the four thresholds, the four taxonomies) THROW
 * `ArgumentInvalidException` when neither tier supplies a value — no default
 * is substituted. `failMode: 'open-to-default'` keys (the five tuning knobs)
 * fall back to `descriptor.default`.
 */
export function resolveGuardrailPolicyValue(key: GuardrailPolicyKey, row: GuardrailPolicyRow = {}): ResolvedGuardrailPolicyValue {
  const descriptor = getGuardrailPolicyDescriptor(key);

  const cascade = walkCascade<'tenant' | 'system', unknown>(
    [
      { source: 'tenant', value: row.tenantValue },
      { source: 'system', value: row.systemValue },
    ],
    undefined,
  );

  if (cascade.source !== 'code-default') {
    return { key, value: cascade.value, source: cascade.source };
  }

  if (descriptor.failMode === 'closed') {
    throw new ArgumentInvalidException(
      `Guardrail policy '${key}' could not be resolved (no tenant or SYSTEM row) and is declared fail-closed; ` +
        'no default is substituted (this key decides a verdict).',
    );
  }
  return { key, value: descriptor.default, source: 'code-default' };
}

// ────────────────────────── Tighten-only floor ───────────────────────────

/**
 * Thrown by `assertGuardrailPolicyFloor` when a tenant-requested value would
 * make a verdict-deciding key LESS strict than the platform floor. A 403 —
 * a privilege boundary — deliberately NOT the 404-over-403 cross-tenant
 * posture (the caller unambiguously owns this row) and NOT a silent clamp
 * (decision D2, verbatim: "not a silent clamp and not a 404").
 */
export class GuardrailPolicyFloorViolation extends ForbiddenException {
  constructor(
    public readonly key: GuardrailPolicyKey,
    public readonly requested: unknown,
    public readonly floor: unknown,
  ) {
    super(
      `Guardrail policy '${key}' may only be tightened relative to the platform floor. ` +
        `Requested ${JSON.stringify(requested)} is weaker than the floor ${JSON.stringify(floor)}.`,
    );
  }
}

/**
 * Enforce the tighten-only floor for ONE tenant write, ONCE, here — the
 * single place decision D2 calls for. `floor` is the value the caller already
 * resolved for the PLATFORM lane (the SYSTEM row if one exists, else
 * `descriptor.default` for the tuning keys — the four closed threshold/
 * taxonomy floors are never undefined in practice because a SYSTEM row is
 * seeded before any tenant may write, but an absent floor is treated as
 * "nothing to enforce against" rather than a spurious failure).
 *
 * A no-op for any key absent from `GUARDRAIL_POLICY_FLOOR_DIRECTIONS` — the
 * five tuning knobs, or an unrecognised key, both plainly out of scope. Never
 * mutates or substitutes `requested`; on a violation it throws
 * `GuardrailPolicyFloorViolation`, on success it returns without a value —
 * the caller writes exactly what was requested, unclamped.
 */
export function assertGuardrailPolicyFloor(key: GuardrailPolicyKey, requested: unknown, floor: unknown): void {
  const short = key.slice(GUARDRAIL_POLICY_KEY_PREFIX.length) as GuardrailPolicyShortKey;
  const direction = GUARDRAIL_POLICY_FLOOR_DIRECTIONS[short];
  if (!direction) return;
  if (floor === null || floor === undefined) return;

  if (direction === 'superset-is-stricter') {
    if (!Array.isArray(requested) || !Array.isArray(floor)) return;
    const missing = (floor as unknown[]).filter((label) => !requested.includes(label));
    if (missing.length > 0) {
      throw new GuardrailPolicyFloorViolation(key, requested, floor);
    }
    return;
  }

  if (typeof requested !== 'number' || typeof floor !== 'number') return;

  if (direction === 'lower-is-stricter' && requested > floor) {
    throw new GuardrailPolicyFloorViolation(key, requested, floor);
  }
  if (direction === 'higher-is-stricter' && requested < floor) {
    throw new GuardrailPolicyFloorViolation(key, requested, floor);
  }
}
