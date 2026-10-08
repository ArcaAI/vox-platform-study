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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { GUARDRAIL_JUDGE_UNTRUSTED_DATA_CLAUSE } from '@arcaai/types';

import { SYSTEM_TENANT_ID } from '../00-constants';
import { SYSTEM_TASK_DEFAULT_ROUTING } from '../16-ai-routing-policy';
import { LLM_AI_MODELS } from '../ai-models/llm';
import { DEFAULT_AI_MODELS, seedAiModels, retireCustomerTenantAiModels } from '../06-ai-models';

// Recovered VERBATIM from commit 567d4baf5^ (deleted by 567d4baf5) —
// apps/guardrail/src/guardrail/services/external_text_client.py::MEDICAL_VALIDATION_CRITERIA.
const RECOVERED_MEDICAL_VALIDATION_CRITERIA =
  'You are a medical context validator. Your task is to determine if the provided text is related to medical documentation, clinical notes, patient care, or healthcare services. Analyze the text and respond ONLY with a JSON object in this exact format:\n{"is_medical": true/false, "confidence": 0.0-1.0, "context_type": "clinical/administrative/general", "reasoning": "brief explanation"}\n\nMedical context includes: patient records, clinical notes, diagnoses, treatments, medications, symptoms, medical procedures, healthcare consultations, referrals, prescriptions, vital signs, medical history, physical examinations, lab results, imaging reports, care plans, discharge summaries.\n\nNon-medical context includes: general conversation, business documents, technical documentation, entertainment content, personal communications unrelated to healthcare.';

// TASK-1050 OD-5 (a) — the recovered text plus the README §3.2 untrusted-data clause, and nothing else.
const SEEDED_MEDICAL_VALIDATION_CRITERIA = `${RECOVERED_MEDICAL_VALIDATION_CRITERIA}\n\n${GUARDRAIL_JUDGE_UNTRUSTED_DATA_CLAUSE}`;

/** The governed key catalogue guardrail exports from `core/policy.py::_SPECS` (TASK-1050 §11.3 A). */
const POLICY_KEYS = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../../../../../apps/guardrail/src/guardrail/tests/contracts/policy-keys.json', import.meta.url)),
      'utf8',
    ),
  ) as { keys: { key: string; failMode: string; taskKey: string }[] }
).keys;

function findGraniteRow() {
  const row = LLM_AI_MODELS.find((m) => m.slug === 'granite-guardian-4.1-8b' && m.tenantId === SYSTEM_TENANT_ID);
  if (!row) throw new Error('granite-guardian-4.1-8b SYSTEM row not found in LLM_AI_MODELS');
  return row;
}

describe('SYSTEM granite-guardian-4.1-8b row carries the guardrail policy blob', () => {
  it('sets metaData.policy.medicalValidationCriteria to the recovered text verbatim, plus only the TASK-1050 untrusted-data clause', () => {
    const row = findGraniteRow();
    expect(row.metaData?.policy?.medicalValidationCriteria).toBe(SEEDED_MEDICAL_VALIDATION_CRITERIA);
  });

  // TASK-886 removed `injectionScreeningCriteria` from `core/policy.py::_SPECS`
  // outright — it had no reader anywhere, and a fail-closed key that cannot move
  // anything is worse than an absent one. It was never seeded; this assertion
  // stays so a re-introduction has to come with its reader and a deliberate
  // decision, rather than arriving quietly in a seed blob.
  it('does not seed injectionScreeningCriteria (removed from core/policy.py by TASK-886)', () => {
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

  it('only the judge rows and the guardrail.safety row carry a policy blob (no accidental spread onto other rows)', () => {
    const withPolicy = DEFAULT_AI_MODELS.filter((m) => m.metaData?.policy !== undefined);
    // TASK-1050: the guardrail.safety row (gliguard) carries bands + classifier timeout; the PII row carries piiLeakQuasiIdentifierLabels.
    // TASK-1050: the Qwen3Guard judge row carries its own model-coupled judge hyperparameters.
    expect(withPolicy.map((m) => `${m.tenantId}::${m.slug}`).sort()).toEqual(
      [
        `${SYSTEM_TENANT_ID}::gliguard-llm-guardrails-300m`,
        `${SYSTEM_TENANT_ID}::gliner2-privacy-filter-pii-multi`,
        `${SYSTEM_TENANT_ID}::granite-guardian-4.1-8b`,
        `${SYSTEM_TENANT_ID}::qwen3guard-gen-0.6b`,
      ].sort(),
    );
  });

  // TASK-1050 (README §5 step 7): every FAIL_CLOSED key `_SPECS` declares has a reader in apps/guardrail
  // (the membership rule), so an unseeded one is a permanent 503 / undetermined on that lane. Each must be
  // seeded on the SYSTEM row its task key elects, and the judge hyperparameters on EVERY judge row (they
  // are read off whichever row a lane elects).
  it('seeds every FAIL_CLOSED policy key on the SYSTEM row its task key elects', () => {
    const elected = new Map(SYSTEM_TASK_DEFAULT_ROUTING.map((r) => [r.taskKey, r.modelSlug]));
    const closed = POLICY_KEYS.filter((k) => k.failMode === 'closed');
    expect(closed.length).toBeGreaterThan(0);
    for (const spec of closed) {
      const slug = elected.get(spec.taskKey);
      expect(slug, `${spec.key}: ${spec.taskKey} has no SYSTEM election`).toBeDefined();
      const policy = DEFAULT_AI_MODELS.find((m) => m.slug === slug && m.tenantId === SYSTEM_TENANT_ID)?.metaData?.policy;
      expect(policy?.[spec.key], `${spec.key} on ${slug}`).toBeDefined();
    }
  });

  it('seeds judgeTemperature and judgeMaxTokens on every row that declares a judge', () => {
    const judges = DEFAULT_AI_MODELS.filter((m) => m.metaData?.judge !== undefined);
    expect(judges.map((m) => m.slug).sort()).toEqual(['granite-guardian-4.1-8b', 'qwen3guard-gen-0.6b']);
    for (const m of judges) {
      expect(typeof m.metaData!.policy!.judgeTemperature, m.slug).toBe('number');
      expect(typeof m.metaData!.policy!.judgeMaxTokens, m.slug).toBe('number');
    }
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

  const graniteUpdate = (updates: UpdateCall[]) => updates.find((u) => u.where.id === `existing-${SYSTEM_TENANT_ID}-granite-guardian-4.1-8b`);

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
        medicalValidationCriteria: SEEDED_MEDICAL_VALIDATION_CRITERIA,
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

  it('writes metaData exactly as the seed row declares it, and never invents one for a row that declares none', async () => {
    const { client, updates } = makeExistingRowClient();
    await seedAiModels(client as never);

    // TASK-1036 stamps `metaData.capabilities` on every row, so no seeded row is metaData-less any
    // more. The property this pins is unchanged: the update payload carries the seed row's own
    // blob (policy included), and a row that declared none would get no `metaData` key at all.
    for (const row of DEFAULT_AI_MODELS.filter((m) => m.slug !== 'granite-guardian-4.1-8b')) {
      const update = updates.find((u) => u.where.id === `existing-${row.tenantId}-${row.slug}`);
      expect(update, row.slug).toBeDefined();
      if (row.metaData === undefined) expect(update!.data).not.toHaveProperty('metaData');
      else expect(update!.data.metaData, row.slug).toEqual(row.metaData);
    }
  });
});
