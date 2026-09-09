/**
 * AI task-default + companion seed invariants (post-consolidation).
 *
 * Static + mock-client assertions over the EXPORTED seed data (no live DB),
 * following the conventions of `seed.test.ts` (this dir) and
 * `src/__tests__/seed.test.ts`:
 *
 *   1. The SYSTEM routing elections (`16-ai-routing-policy.ts`) reference
 *      catalogue slugs with the compatible `taskType` (or a slug in the
 *      retirement ledger — a retired selection fails closed exactly as a
 *      DISABLED one did), and the seed step is CREATE-ONLY.
 *   2. Companion updates: the HarnessPolicy TEXT default is GONE (TASK-881);
 *      the six superseded GlobalSetting keys are gone from the seeded arrays
 *      and covered by the idempotent soft-retire sweep; the retired
 *      `AiTaskDefault` subject carries no tenant grant (TASK-881).
 *
 * The model CATALOGUE itself (35 SYSTEM rows, the retirement ledger, the
 * pipeline-reference guard and the sweeps) is pinned by
 * `ai-model-registry-seed.test.ts` since TASK-860.
 */

import { describe, it, expect, vi } from 'vitest';

import { DEFAULT_AI_MODELS, RETIRED_AI_MODEL_SLUGS } from '../06-ai-models';
import { ModelTaskType } from '../ai-models/shared';
import * as globalSetting from '../11-global-setting';
import { DEFAULT_POLICIES } from '../01-policy';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from '../00-constants';

// Loose views over exports that only exist after the seed consolidation
// lands (namespace access keeps this file compiling against the OLD seed so
// the TDD RED run shows real assertion failures, not transform errors).
const RETIRED_GLOBAL_SETTING_KEYS = (globalSetting as Record<string, unknown>).RETIRED_GLOBAL_SETTING_KEYS as
  ReadonlyArray<{ namespace: string; key: string }> | undefined;
const retireSupersededGlobalSettings = (globalSetting as Record<string, unknown>).retireSupersededGlobalSettings as
  ((client: unknown) => Promise<{ retired: number }>) | undefined;

type SeedModel = (typeof DEFAULT_AI_MODELS)[number];

const catalog = DEFAULT_AI_MODELS as readonly SeedModel[];
const bySlug = (slug: string) => catalog.find((m) => m.slug === slug);

// =============================================================================
// 1. SYSTEM routing elections (the retired AiTaskDefault seed's successor)
// =============================================================================

describe('SYSTEM routing-election seed', () => {
  const TASK_KEY_TO_TASK_TYPE: Record<string, string> = {
    'guardrail.validate': ModelTaskType.GUARDRAIL,
    'nlp.ner': 'TOKEN_CLASSIFICATION',
    'nlp.classification': 'TEXT_CLASSIFICATION',
    // guardrail safety/groundedness, harness judge, diagnosis.
    // the safety plane split in two: moderation is a
    // multi-task TEXT classifier, PII spans are TOKEN classification.
    'guardrail.safety': 'TEXT_CLASSIFICATION',
    'guardrail.pii': 'TOKEN_CLASSIFICATION',
    // the JOINT checkpoint. Its primary shape is span extraction,
    // so it is TOKEN_CLASSIFICATION even though it also serves the six safety
    // tasks; `metaData.capabilities` carries the dual envelope.
    'guardrail.pii.spans': 'TOKEN_CLASSIFICATION',
    'guardrail.groundedness': 'TEXT_CLASSIFICATION',
    'harness.judge': 'TEXT_GENERATION',
    'nlp.diagnosis': 'TEXT_CLASSIFICATION',
  };

  // TASK-862: the SYSTEM task defaults are seeded as ELECTED `AiRoutingPolicy`
  // rows (`16-ai-routing-policy.ts`); the retired `AiTaskDefault` seed is gone.
  const loadModule = async () =>
    import('../16-ai-routing-policy') as Promise<{
      SYSTEM_TASK_DEFAULT_ROUTING: Array<{
        id: string;
        tenantId: string;
        taskKey: string;
        modelSlug: string;
      }>;
      seedAiRoutingPolicy: (client: unknown) => Promise<{ created: number; skipped: number; unresolved: number }>;
    }>;

  it('seeds exactly the nine SYSTEM elections with deterministic ids — no text.* key (TASK-881)', async () => {
    const { SYSTEM_TASK_DEFAULT_ROUTING: SYSTEM_AI_TASK_DEFAULTS } = await loadModule();
    const byKey = new Map(SYSTEM_AI_TASK_DEFAULTS.map((r) => [r.taskKey, r]));
    expect(SYSTEM_AI_TASK_DEFAULTS.length).toBe(9);
    expect(byKey.get('guardrail.validate')?.modelSlug).toBe('granite-guardian-4.1-8b');
    expect(byKey.get('nlp.ner')?.modelSlug).toBe('medical-ner');
    // nlp.classification is the doc-type classifier (fail-closed
    // placeholder); the diagnosis suggester moved to nlp.diagnosis.
    expect(byKey.get('nlp.classification')?.modelSlug).toBe('nlp-doc-type-classifier');
    expect(byKey.get('nlp.diagnosis')?.modelSlug).toBe('symps-disease-bert-v3-c41');
    // TASK-881: no text.* election — text generation selects through the
    // assigned TEXT_GENERATION agent; a routing row for it served nothing.
    for (const key of ['text.live', 'text.finalize', 'text.test', 'text.live.fallback', 'text.finalize.fallback']) {
      expect(byKey.has(key), key).toBe(false);
    }
    // guardrail safety/groundedness + harness judge selection.
    expect(byKey.get('guardrail.safety')?.modelSlug).toBe('gliguard-llm-guardrails-300m');
    expect(byKey.get('guardrail.pii')?.modelSlug).toBe('gliner2-privacy-filter-pii-multi');
    // completes the owner's three-model roster.
    expect(byKey.get('guardrail.pii.spans')?.modelSlug).toBe('gliner2-guardrails-pii-multi');
    expect(byKey.get('guardrail.groundedness')?.modelSlug).toBe('minicheck-flan-t5-large');
    // The judge points at the model the dev LM Studio instance actually serves.
    // OWNER DIRECTIVE 2026-08-16 fixed the FAMILY (LM Studio + gemma-4 E4B);
    // 2026-09-03 narrows it to the QAT build every other
    // text-generation task now names, so judgement and documentation resolve
    // one identity rather than two. Both are E4B — this is a narrowing of the
    // earlier directive, not a reversal of it.
    expect(byKey.get('harness.judge')?.modelSlug).toBe('lms-gemma-4-e2b-it-qat');
    SYSTEM_AI_TASK_DEFAULTS.forEach((row) => {
      expect(row.tenantId).toBe(SYSTEM_TENANT_ID);
      expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
    expect(new Set(SYSTEM_AI_TASK_DEFAULTS.map((r) => r.id)).size).toBe(9);
  });

  it('references catalog slugs whose taskType matches the task key', async () => {
    const { SYSTEM_TASK_DEFAULT_ROUTING: SYSTEM_AI_TASK_DEFAULTS } = await loadModule();
    SYSTEM_AI_TASK_DEFAULTS.forEach((row) => {
      const model = bySlug(row.modelSlug);
      if (!model) {
        // TASK-860 retired the DISABLED `nlp-doc-type-classifier` placeholder
        // that `nlp.classification` pointed at. A retired selection resolves
        // to no ENABLED model — the same fail-closed 503 the DISABLED row
        // produced — so the reference is tolerated ONLY through the ledger.
        // `16-ai-task-default.ts` itself is retired by TASK-862.
        expect(RETIRED_AI_MODEL_SLUGS, `routing election ${row.taskKey} references unknown slug ${row.modelSlug}`).toContain(row.modelSlug);
        return;
      }
      expect(model.taskType).toBe(TASK_KEY_TO_TASK_TYPE[row.taskKey]);
    });
  });

  it('is CREATE-ONLY: never overwrites an existing elected (tenant, taskKey) default', async () => {
    const { seedAiRoutingPolicy } = await loadModule();
    const client = {
      aiRoutingPolicy: {
        findFirst: vi.fn(async () => ({ id: 'existing', modelId: 'admin-chosen' })),
        create: vi.fn(),
        update: vi.fn(),
      },
      aiModel: { findFirst: vi.fn() },
    };
    const result = await seedAiRoutingPolicy(client as never);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(9);
    expect(client.aiRoutingPolicy.create).not.toHaveBeenCalled();
    expect(client.aiRoutingPolicy.update).not.toHaveBeenCalled();
    expect(client.aiModel.findFirst).not.toHaveBeenCalled();
  });

  it('elects the missing rows on a cold seed: ACTIVE, isDefault, bound to the SYSTEM model by FK, system user as creator', async () => {
    const { seedAiRoutingPolicy } = await loadModule();
    const created: Array<{ data: Record<string, unknown> }> = [];
    const client = {
      aiRoutingPolicy: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args);
          return args.data;
        }),
      },
      aiModel: { findFirst: vi.fn(async ({ where }: { where: { slug: string } }) => ({ id: `model:${where.slug}`, slug: where.slug })) },
    };
    const result = await seedAiRoutingPolicy(client as never);
    expect(result.created).toBe(9);
    expect(result.unresolved).toBe(0);
    created.forEach(({ data }) => {
      expect(data.tenantId).toBe(SYSTEM_TENANT_ID);
      expect(data.createdBy).toBe(SYSTEM_USER_ID);
      expect(data.isDefault).toBe(true);
      expect(data.enabled).toBe(true);
      expect(data.status).toBe('ACTIVE');
      expect(String(data.modelId)).toMatch(/^model:/);
      expect(data.taskKind).not.toBeNull();
    });
  });

  it('skips (fails closed) a default whose slug resolves to no ENABLED SYSTEM model', async () => {
    const { seedAiRoutingPolicy } = await loadModule();
    const client = {
      aiRoutingPolicy: { findFirst: vi.fn(async () => null), create: vi.fn() },
      aiModel: { findFirst: vi.fn(async () => null) },
    };
    const result = await seedAiRoutingPolicy(client as never);
    expect(result.created).toBe(0);
    expect(result.unresolved).toBe(9);
    expect(client.aiRoutingPolicy.create).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 2. Companion seeds — HarnessPolicy default + GlobalSetting retirement + RBAC
// =============================================================================

describe('companion seed updates', () => {
  // TASK-881: `SYSTEM_HARNESS_POLICY_TEXT_DEFAULTS` is gone with the two
  // HarnessPolicy text columns. The platform text default is the SYSTEM
  // TEXT_GENERATION agent's primary (TASK-876), pinned by the agent seed tests.
  it('exports no HarnessPolicy TEXT default any more', async () => {
    const mod = (await import('../13-harness-policy')) as Record<string, unknown>;
    expect(mod.SYSTEM_HARNESS_POLICY_TEXT_DEFAULTS).toBeUndefined();
  });

  it('removes the six superseded GlobalSetting keys from the seeded arrays', () => {
    // These `smr` literals are DB row keys, not code identifiers — D-740-1 leaves them
    // spelled `smr` on purpose (see RETIRED_GLOBAL_SETTING_KEYS in 11-global-setting.ts).
    const retiredKeys = [
      'default-smr-provider',
      'default-smr-model',
      'smr-provider-models',
      'default-guardrail-provider',
      'default-guardrail-model',
      'guardrail-azure-deployment',
    ];
    const seededKeys = new Set(globalSetting.ALL_SETTINGS.map((s) => s.key));
    retiredKeys.forEach((key) => {
      expect(seededKeys.has(key), `GlobalSetting key ${key} is still seeded`).toBe(false);
    });
    // The survivors stay untouched.
    expect(seededKeys.has('text-azure-deployment')).toBe(true);
    expect(seededKeys.has('guardrail-provider-models')).toBe(true);
    expect(seededKeys.has('default-stt-model')).toBe(true);
  });

  it('declares exactly the superseded keys in RETIRED_GLOBAL_SETTING_KEYS', () => {
    expect(RETIRED_GLOBAL_SETTING_KEYS).toBeDefined();
    const asStrings = (RETIRED_GLOBAL_SETTING_KEYS ?? []).map((k) => `${k.namespace}/${k.key}`).sort();
    // Every entry keeps its ORIGINAL `smr` spelling: these name rows that exist in
    // already-provisioned databases, so renaming them would point the retirement sweep
    // at rows that do not exist. `smr/smr-azure-deployment` is the D-740-1 addition —
    // the key moved to `text/text-azure-deployment`, and this retires the old copy.
    expect(asStrings).toEqual(
      [
        'guardrail/default-guardrail-provider',
        'guardrail/default-guardrail-model',
        'guardrail/guardrail-azure-deployment',
        'smr/default-smr-provider',
        'smr/default-smr-model',
        'smr/smr-azure-deployment',
        'ux-constants/smr-provider-models',
        // TASK-932 R-8 — the five advisory `feature-flags` rows. Nothing read
        // them, so dropping them from the seeded arrays is not enough on its
        // own: an already-provisioned database would keep serving five toggles
        // that do nothing. This is the list that sweeps those copies.
        'feature-flags/enable-transcription',
        'feature-flags/enable-dna-style',
        'feature-flags/enable-cross-chain-summary',
        'feature-flags/enable-ner-extraction',
        'feature-flags/enable-code-switching',
        // TASK-932 wave 4 additions (2026-09-09). OD-1: the per-tenant
        // `enable-consultation-sharing` clone is retired — the registry
        // cascade's descriptor default now supplies the same effective value
        // on absence. OD-8: the legacy S3_PUBLIC_BUCKET/S3_PRIVATE_BUCKET
        // platform bucket pair — zero production consumers once
        // `S3Service.testConnection()` stopped depending on either.
        'feature-flags/enable-consultation-sharing',
        'platform/S3_PRIVATE_BUCKET',
        'platform/S3_PUBLIC_BUCKET',
      ].sort(),
    );
  });

  it('soft-retires the superseded GlobalSetting rows idempotently (DELETED + stamps + version bump)', async () => {
    expect(retireSupersededGlobalSettings).toBeTypeOf('function');
    const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const client = {
      globalSetting: {
        updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updates.push(args);
          return { count: 2 };
        }),
      },
    };
    const result = await retireSupersededGlobalSettings!(client as never);

    // 15 = the original six superseded keys, + `smr/smr-azure-deployment`
    // (D-740-1 moved that key to the `text` namespace, so the old row must be
    // swept too), + the five advisory `feature-flags` rows TASK-932 R-8
    // removed, + the three TASK-932 wave-4 additions (OD-1's
    // `enable-consultation-sharing`, OD-8's S3_PUBLIC_BUCKET/
    // S3_PRIVATE_BUCKET).
    expect(client.globalSetting.updateMany).toHaveBeenCalledTimes(RETIRED_GLOBAL_SETTING_KEYS!.length);
    expect(client.globalSetting.updateMany).toHaveBeenCalledTimes(15);
    expect(result.retired).toBe(30);
    updates.forEach(({ where, data }) => {
      expect(where.resourceStatus).toEqual({ not: 'DELETED' });
      expect(where.namespace).toBeTypeOf('string');
      expect(where.key).toBeTypeOf('string');
      // Sweeps EVERY tenant's copy — no tenant pin.
      expect(where.tenantId).toBeUndefined();
      expect(data.resourceStatus).toBe('DELETED');
      expect(data.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      expect(data.resourceStatusUpdatedBy).toBe(SYSTEM_USER_ID);
      expect(data.version).toEqual({ increment: 1 });
    });
  });

  // TASK-881: the `AiTaskDefault` subject is gone with the facade and its
  // routes. Selection is the super-admin-only `AiRoutingPolicy` plane, so no
  // tenant-scoped grant may name it — a reappearing rule would hand tenants a
  // write path the service no longer guards.
  it('grants tenant admins NOTHING on the retired AiTaskDefault subject', () => {
    const tenantFullAccess = DEFAULT_POLICIES.find((p) => p.name === 'tenant-full-access');
    const rule = tenantFullAccess?.rules.find((r) => (r as { subject?: string }).subject === 'AiTaskDefault');
    expect(rule).toBeUndefined();
  });
});
