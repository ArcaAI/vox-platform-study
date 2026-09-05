/**
 * seed data for guardrail's policy plane
 *
 * `apps/guardrail/src/guardrail/core/policy.py` resolves `medicalValidationCriteria`
 * (`failMode: closed`) from `AiModel._metadata.policy` through the tenant → SYSTEM
 * cascade. Before this seed landed, EVERY `AiModel` row had `_metadata.policy`
 * absent, so `GuardrailPolicy.require_criteria` always raised and
 * `POST /medical/validate` was permanently 503 — the correct fail-closed posture
 * for missing config, but only correct once the config actually gets seeded.
 *
 * This file locks three things:
 *
 *   1. The SYSTEM `granite-guardian-4.1-8b` row (`guardrail.validate`'s platform
 *      default, TASK_KEY_GUARDRAIL_VALIDATE in `core/tenant_config.py`) carries
 *      `metaData.policy.medicalValidationCriteria`, VERBATIM from the deleted
 *      `MEDICAL_VALIDATION_CRITERIA` Python literal (commit `567d4baf5^`,
 *      `apps/guardrail/src/guardrail/services/external_text_client.py`).
 *   2. `seedAiModels` (`../06-ai-models.ts`) is NOT create-only for `AiModel`: it
 *      `update()`s an existing row's `metaData` column (full-column write, the
 *      same mechanism `labelTaxonomy` already relies on in `ai-models/nlp.ts`),
 *      so a `db:seed` re-run against the live dev DB — which already has this
 *      row — actually propagates the policy instead of skipping it. Idempotent:
 *      re-running produces the identical payload, not an accumulating one.
 *   3. Customer-tenant clones of the same slug are deliberately NOT seeded with
 *      `policy`: `tenant_config.py::_row_rank` always prefers the SYSTEM
 *      `AiModel` row over a tenant-owned copy of the SAME slug (shared-read,
 *      pinned by the Python suite's `test_db_prefers_system_model_row_over_tenant_copy`),
 *      so a clone's `metaData.policy` is never consulted for `guardrail.validate`.
 */

import { describe, it, expect, vi } from 'vitest';

import { SYSTEM_TENANT_ID } from '../00-constants';
import { LLM_AI_MODELS } from '../ai-models/llm';
import { DEFAULT_AI_MODELS, seedAiModels, retireCustomerTenantAiModels } from '../06-ai-models';

// Recovered VERBATIM from commit 567d4baf5^ (deleted by 567d4baf5) —
// apps/guardrail/src/guardrail/services/external_text_client.py::MEDICAL_VALIDATION_CRITERIA.
const RECOVERED_MEDICAL_VALIDATION_CRITERIA =
  'You are a medical context validator. Your task is to determine if the provided text is related to medical documentation, clinical notes, patient care, or healthcare services. Analyze the text and respond ONLY with a JSON object in this exact format:\n{"is_medical": true/false, "confidence": 0.0-1.0, "context_type": "clinical/administrative/general", "reasoning": "brief explanation"}\n\nMedical context includes: patient records, clinical notes, diagnoses, treatments, medications, symptoms, medical procedures, healthcare consultations, referrals, prescriptions, vital signs, medical history, physical examinations, lab results, imaging reports, care plans, discharge summaries.\n\nNon-medical context includes: general conversation, business documents, technical documentation, entertainment content, personal communications unrelated to healthcare.';

function findGraniteRow() {
  const row = LLM_AI_MODELS.find((m) => m.slug === 'granite-guardian-4.1-8b' && m.tenantId === SYSTEM_TENANT_ID);
  if (!row) throw new Error('granite-guardian-4.1-8b SYSTEM row not found in LLM_AI_MODELS');
  return row;
}

describe('SYSTEM granite-guardian-4.1-8b row carries the guardrail policy blob', () => {
  it('sets metaData.policy.medicalValidationCriteria to the recovered text, verbatim', () => {
    const row = findGraniteRow();
    expect(row.metaData?.policy?.medicalValidationCriteria).toBe(RECOVERED_MEDICAL_VALIDATION_CRITERIA);
  });

  it('does not seed injectionScreeningCriteria (declared in core/policy.py but unused by any call site)', () => {
    const row = findGraniteRow();
    expect(row.metaData?.policy?.injectionScreeningCriteria).toBeUndefined();
  });

  // TASK-878 — the two judge hyperparameters. Unlike injectionScreeningCriteria
  // above they DO have a reader (`core/tenant_config.build_judge_client`), which
  // is the whole distinction: a fail-closed key without a reader is unreviewed
  // policy, a fail-closed key without a SEEDED VALUE is a permanent 503.
  it('seeds judgeTemperature and judgeMaxTokens at the JudgePolicy literals they replaced', () => {
    const row = findGraniteRow();
    // Verbatim from `apps/guardrail/src/guardrail/core/config.py::JudgePolicy`
    // before TASK-878 deleted them (`temperature = 0.05`, `max_tokens = 300`),
    // so moving them off the code default changed no behaviour.
    expect(row.metaData?.policy?.judgeTemperature).toBe(0.05);
    expect(row.metaData?.policy?.judgeMaxTokens).toBe(300);
  });

  it('keeps both inside the declared bounds of core/policy.py::_SPECS', () => {
    // `judgeTemperature` [0.0, 2.0], `judgeMaxTokens` [1, 100000]. A fail-closed
    // key is never clamped — an out-of-range seed would 503 the validate route
    // exactly as an absent one does, so the bounds are checked on this side too.
    const policy = findGraniteRow().metaData!.policy!;
    expect(policy.judgeTemperature).toBeGreaterThanOrEqual(0);
    expect(policy.judgeTemperature).toBeLessThanOrEqual(2);
    expect(policy.judgeMaxTokens).toBeGreaterThanOrEqual(1);
    expect(policy.judgeMaxTokens).toBeLessThanOrEqual(100_000);
  });

  it('is the only DEFAULT_AI_MODELS row carrying a policy blob (no accidental spread onto other rows)', () => {
    const withPolicy = DEFAULT_AI_MODELS.filter((m) => m.metaData?.policy !== undefined);
    expect(withPolicy.map((m) => `${m.tenantId}::${m.slug}`)).toEqual([`${SYSTEM_TENANT_ID}::granite-guardian-4.1-8b`]);
  });
});

// =============================================================================
// seedAiModels propagates metaData to an ALREADY-EXISTING row (mock client)
// =============================================================================

describe('seedAiModels propagates the policy blob to an existing AiModel row', () => {
  type UpdateCall = { where: { id: string }; data: Record<string, unknown> };

  const makeExistingRowClient = () => {
    const updates: UpdateCall[] = [];
    const creates: Array<{ data: Record<string, unknown> }> = [];
    const client = {
      aiModel: {
        findFirst: vi.fn(async (args: { where: { tenantId: string; slug: string } }) => ({
          id: `existing-${args.where.tenantId}-${args.where.slug}`,
        })),
        update: vi.fn(async (args: UpdateCall) => {
          updates.push(args);
          return {};
        }),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          creates.push(args);
          return {};
        }),
      },
    };
    return { client, updates, creates };
  };

  const graniteUpdate = (updates: UpdateCall[]) =>
    updates.find((u) => u.where.id === `existing-${SYSTEM_TENANT_ID}-granite-guardian-4.1-8b`);

  it('writes metaData.policy on the existing row via update() (not skipped as create-only)', async () => {
    const { client, updates, creates } = makeExistingRowClient();

    await seedAiModels(client as never);

    // Every row already "existed" (mocked), so seedAiModels must never create.
    expect(creates).toHaveLength(0);

    const update = graniteUpdate(updates);
    expect(update).toBeDefined();
    // TASK-860 added the publisher's `hubArtifact` next to the policy blob;
    // the policy itself must still travel verbatim.
    expect(update!.data.metaData).toMatchObject({
      policy: {
        medicalValidationCriteria: RECOVERED_MEDICAL_VALIDATION_CRITERIA,
        // TASK-878: the judge hyperparameters ride the SAME full-column write —
        // a `db:seed` re-run against a dev DB that already has this row must
        // propagate them, or the validate route 503s on an existing install.
        judgeTemperature: 0.05,
        judgeMaxTokens: 300,
      },
    });
  });

  it('is idempotent: re-running produces the identical update payload, not an accumulating one', async () => {
    const { client, updates } = makeExistingRowClient();

    await seedAiModels(client as never);
    await seedAiModels(client as never);

    const graniteUpdates = updates.filter((u) => u.where.id === `existing-${SYSTEM_TENANT_ID}-granite-guardian-4.1-8b`);
    expect(graniteUpdates).toHaveLength(2);
    expect(graniteUpdates[0]!.data).toEqual(graniteUpdates[1]!.data);
  });

  it('leaves every other row\'s update payload untouched (no metaData key introduced where the seed sets none)', async () => {
    const { client, updates } = makeExistingRowClient();
    await seedAiModels(client as never);

    const otherRowsWithNoSeedMetaData = DEFAULT_AI_MODELS.filter((m) => m.slug !== 'granite-guardian-4.1-8b' && m.metaData === undefined);
    expect(otherRowsWithNoSeedMetaData.length).toBeGreaterThan(0);

    for (const row of otherRowsWithNoSeedMetaData) {
      const update = updates.find((u) => u.where.id === `existing-${row.tenantId}-${row.slug}`);
      expect(update).toBeDefined();
      expect(update!.data).not.toHaveProperty('metaData');
    }
  });
});

// =============================================================================
// retireCustomerTenantAiModels — the registry is SYSTEM-only (TASK-860): the
// per-tenant clones the seed used to materialise (and the policy blob they
// carried) are swept, never re-created.
// =============================================================================

describe('retireCustomerTenantAiModels and the policy blob', () => {
  it('soft-deletes every non-SYSTEM AiModel row in one sweep and never creates a clone', async () => {
    const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const client = {
      aiModel: {
        updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updates.push(args);
          return { count: 3 };
        }),
        create: vi.fn(),
      },
    };

    const result = await retireCustomerTenantAiModels(client as never);

    expect(result.retired).toBe(3);
    expect(client.aiModel.create).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.where).toEqual({ tenantId: { not: SYSTEM_TENANT_ID }, resourceStatus: { not: 'DELETED' } });
    expect(updates[0]!.data.resourceStatus).toBe('DELETED');
    expect(updates[0]!.data.version).toEqual({ increment: 1 });
  });
});
