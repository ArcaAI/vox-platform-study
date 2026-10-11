/**
 * Platform-Default Guardrail AVAILABILITY Seed (TASK-886).
 *
 * Creates the ONE row that makes "which safety policies apply" admin-managed
 * data rather than a code constant: the SYSTEM-tenant `TenantGuardrailPolicy`.
 * Every customer tenant inherits it on ABSENCE, which is how a tenant with no
 * opinion follows the platform.
 *
 * Every declared check is ON — guardrails check the request AND the response on every
 * LLM call (owner decisions OD-1..OD-5; this reverses the earlier clinical-text calibration,
 * which had five judges off). `response_refusal` alone stays off: a refusal is not unsafe content.
 * `pii_leak` is locality-aware in `apps/text` (blocking on a cloud call before
 * re-identification, detect-and-audit on a local one), which is what lets it ship ON
 * now that a finalized note legitimately re-states the encounter's identifiers.
 * `pii_leak.minScore` is
 * transcribed VERBATIM from `core/policy.py::_SPECS['piiLeakMinScore']` (0.5) —
 * the same discipline the judge hyperparameters were moved under. The runtime
 * composes the availability threshold with the model row's value in the STRICT
 * direction, so the two agreeing is a no-op and any future drift resolves
 * toward more screening, never less.
 *
 * The set is stated here rather than imported from
 * `packages/applications/.../policy-catalogue.ts` because a seed may not import
 * from the applications layer (the established seed convention — see
 * `16-ai-routing-policy.ts`, which mirrors `AI_TASK_KIND_BY_TASK_KEY` for the
 * same reason). `__tests__/task-886-guardrail-availability-seed.test.ts` pins
 * the two against each other so the mirror cannot drift.
 *
 * Idempotent. CREATE-ONLY: an existing row is left untouched, because after the
 * first boot it is the platform admin's to edit and a re-seed must never
 * silently revert a deliberate narrowing of a customer's safety posture.
 *
 * TASK-1050: a COLD database gets the v2 shape below (`directions` + `checks`, with each check's action).
 * An EXISTING database keeps its row as it is — typically the legacy flat shape, without the five new
 * checks. Both normalizers read that as v2, and an absent check takes its catalogue default, which is the
 * same value this seed states (judges off, medical validation locked on), so no reseed is needed for the
 * runtime to agree with this file.
 */
import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/** Stable id so a re-seed and a manual inspection can both find the row. */
export const PLATFORM_GUARDRAIL_AVAILABILITY_ID = '00000000-0000-0000-0018-000000000001';

/**
 * One check's platform-default entry in the v2 shape (`GuardrailCheckPolicy` of `@arcaai/types`). Type aliases,
 * not interfaces, so both keep an implicit index signature and stay assignable to Prisma's `InputJsonValue`.
 */
export type PlatformGuardrailCheckSeed = {
  enabled: boolean;
  action: 'ignore' | 'warn' | 'block';
  /** Set on the catalogue-locked check only (medical validation, OD-9). */
  locked?: boolean;
  minScore?: number;
  /** Inbound checks that screen BOTH trusts: what a flag on a DATA region does (FC-5b, OD-12). */
  dataRegionAction?: 'ignore' | 'warn' | 'block';
  /**
   * TASK-1061 OD-5b: `{label: action}` — what a flag whose labels are all listed does instead of `action`.
   * It only relaxes (never raises a region) and cascades label by label (`core/availability.py`).
   */
  categoryActions?: Record<string, 'ignore' | 'warn' | 'block'>;
};

/** The v2 `TenantGuardrailPolicy.policies` blob (`TenantGuardrailPolicyV2` of `@arcaai/types`). */
export type PlatformGuardrailAvailabilitySeed = {
  directions: { inbound: { enabled: boolean }; outbound: { enabled: boolean } };
  checks: Record<string, PlatformGuardrailCheckSeed>;
};

/**
 * The platform default set, in the TASK-1050 v2 shape (`directions` + `checks`, read by
 * `normalizeTenantGuardrailPolicy` in `@arcaai/types` and `normalize_tenant_guardrail_policy` in
 * `apps/guardrail/.../core/availability.py`). Every value is the catalogue default, stated explicitly so
 * the row is self-describing and a platform admin's edit is a diff against it:
 *
 *   - both directions on (no monitor-only direction);
 *   - the eight classifier checks ON at `block` — except `response_refusal` (see the header) — and the
 *     three inbound ones record-only on DATA regions (`dataRegionAction: 'ignore'`, TASK-1047 FC-5b);
 *   - TASK-1061 (owner OD-4 / OD-5b, 2026-10-11): `jailbreak_detection` screens the request only (its action is
 *     inbound); `response_safety` and `prompt_toxicity`/`response_toxicity`'s `privacy_violation` category are recorded only
 *     (`ignore`, no clinician notice) until a calibrated threshold exists;
 *   - `medical_validation` ON at `block` and LOCKED (OD-9: the platform is for medical use only);
 *   - the four judges OFF (OD-6), at their catalogue actions, so a deploy makes zero judge calls until a
 *     platform admin turns one on.
 *
 * MIRRORS `PLATFORM_DEFAULT_GUARDRAIL_POLICIES` / `GUARDRAIL_CHECK_DEFAULTS` in
 * `packages/applications/src/services/guardrail-availability/policy-catalogue.ts`, whose ids are in turn
 * pinned against `apps/guardrail/src/guardrail/tests/contracts/availability-catalogue.json` — which is
 * what the seed tests pin THIS against.
 */
export const PLATFORM_DEFAULT_GUARDRAIL_AVAILABILITY: PlatformGuardrailAvailabilitySeed = {
  directions: { inbound: { enabled: true }, outbound: { enabled: true } },
  checks: {
    // TASK-1061 OD-4: inbound only — an injection classifier is never run on a model's own output.
    jailbreak_detection: { enabled: true, action: 'block', dataRegionAction: 'ignore' },
    // Owner 2026-10-09 (TASK-1053): the inbound classifiers warn by default (they false-flag clinical notes).
    prompt_safety: { enabled: true, action: 'warn', dataRegionAction: 'ignore' },
    // TASK-1061 OD-5b: `privacy_violation` (sensitive history in a clinical prompt) is recorded only.
    prompt_toxicity: { enabled: true, action: 'warn', dataRegionAction: 'ignore', categoryActions: { privacy_violation: 'ignore' } },
    // TASK-1061 OD-5b (owner 2026-10-11): recorded only — `unsafe` fired on every clinical note. Was `warn` (2026-10-08).
    response_safety: { enabled: true, action: 'ignore' },
    // TASK-1062 D-1: `privacy_violation` is recorded only, as on prompt_toxicity.
    response_toxicity: { enabled: true, action: 'warn', categoryActions: { privacy_violation: 'ignore' } },
    // A refusal is not unsafe content, so it is the one classifier check that ships off.
    response_refusal: { enabled: false, action: 'block' },
    pii_leak: { enabled: true, action: 'block', minScore: 0.5 },
    containment_echo: { enabled: true, action: 'block' },
    // TASK-1050: locked on, always block.
    medical_validation: { enabled: true, action: 'block', locked: true },
    // TASK-1050: the four judges ship OFF (OD-6).
    injection_judge: { enabled: false, action: 'ignore' },
    unsafe_content_judge: { enabled: false, action: 'warn' },
    clinical_safety_judge: { enabled: false, action: 'warn' },
    leakage_judge: { enabled: false, action: 'block' },
  },
};

export const seedGuardrailAvailability = async (client: CorePrismaClient): Promise<void> => {
  console.log('Seeding platform-default guardrail availability...');
  try {
    const existing = await client.tenantGuardrailPolicy.findFirst({
      where: { tenantId: SYSTEM_TENANT_ID, resourceStatus: { not: 'DELETED' } },
    });

    if (existing) {
      console.log(`Platform-default guardrail availability already present (id=${existing.id}) — left untouched (admin-owned)`);
      return;
    }

    await client.tenantGuardrailPolicy.create({
      data: {
        id: PLATFORM_GUARDRAIL_AVAILABILITY_ID,
        tenantId: SYSTEM_TENANT_ID,
        policies: PLATFORM_DEFAULT_GUARDRAIL_AVAILABILITY,
        reason:
          'Platform default: every declared screening check applies to the request and the response, except response_refusal (a refusal is not unsafe content); medical validation is locked on; the four safety judges ship off.',
        createdBy: SYSTEM_USER_ID,
        updatedBy: SYSTEM_USER_ID,
      },
    });
    console.log(`  Created platform-default guardrail availability (id=${PLATFORM_GUARDRAIL_AVAILABILITY_ID})`);
  } catch (error) {
    console.error('Error seeding platform-default guardrail availability:', error);
    throw error;
  }
};
