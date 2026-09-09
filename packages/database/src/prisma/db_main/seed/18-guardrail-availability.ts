/**
 * Platform-Default Guardrail AVAILABILITY Seed (TASK-886).
 *
 * Creates the ONE row that makes "which safety policies apply" admin-managed
 * data rather than a code constant: the SYSTEM-tenant `TenantGuardrailPolicy`.
 * Every customer tenant inherits it on ABSENCE, which is how a tenant with no
 * opinion follows the platform.
 *
 * Every declared check is ON — what `apps/guardrail` did before this row existed —
 * EXCEPT the two outbound judges the owner calibrated OFF for clinical text on
 * 2026-09-09 (TASK-932): `response_toxicity` (the 300M classifier intermittently
 * labels SOAP content such as chest pain / aspirin as toxic) and `pii_leak` (a
 * finalized note legitimately re-states the encounter's own identifiers, which the
 * fragment check reads as a leak). Both blocked live notes end to end; both stay
 * off until retuned for clinical text. `pii_leak.minScore` is
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
 */
import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/** Stable id so a re-seed and a manual inspection can both find the row. */
export const PLATFORM_GUARDRAIL_AVAILABILITY_ID = '00000000-0000-0000-0018-000000000001';

/**
 * The platform default set: every check the screener declares, ON — except the two
 * clinical-text judges calibrated OFF (see the header).
 *
 * MIRRORS `PLATFORM_DEFAULT_GUARDRAIL_POLICIES` in
 * `packages/applications/src/services/guardrail-availability/policy-catalogue.ts`,
 * whose ids are in turn pinned against
 * `apps/guardrail/src/guardrail/tests/contracts/availability-catalogue.json`.
 */
export const PLATFORM_DEFAULT_GUARDRAIL_AVAILABILITY: Record<string, { enabled: boolean; minScore?: number }> = {
  jailbreak_detection: { enabled: true },
  prompt_safety: { enabled: true },
  prompt_toxicity: { enabled: true },
  response_safety: { enabled: true },
  response_toxicity: { enabled: false },
  response_refusal: { enabled: true },
  pii_leak: { enabled: false, minScore: 0.5 },
  containment_echo: { enabled: true },
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
          'Platform default: every declared screening check applies, except response_toxicity and pii_leak — calibrated OFF for clinical text (TASK-932, owner decision 2026-09-09) until the outbound judges are retuned.',
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
