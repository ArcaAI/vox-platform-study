/**
 * AI task-default + companion seed invariants (post-consolidation).
 *
 * Static + mock-client assertions over the EXPORTED seed data (no live DB),
 * following the conventions of `seed.test.ts` (this dir) and
 * `src/__tests__/seed.test.ts`:
 *
 *   1. The SYSTEM `AiTaskDefault` seed rows reference catalogue slugs with the
 *      compatible `taskType` (or a slug in the retirement ledger — a retired
 *      selection fails closed exactly as a DISABLED one did), and the seed
 *      step is CREATE-ONLY.
 *   2. Companion updates: HarnessPolicy TEXT default → `gemma-4-e2b-it-qat`;
 *      the six superseded GlobalSetting keys are gone from the seeded arrays
 *      and covered by the idempotent soft-retire sweep; tenant admins hold
 *      read+manage on `AiTaskDefault`.
 *
 * The model CATALOGUE itself (35 SYSTEM rows, the retirement ledger, the
 * pipeline-reference guard and the sweeps) is pinned by
 * `ai-model-registry-seed.test.ts` since TASK-860.
 */

import { describe, it, expect, vi } from 'vitest';

import { DEFAULT_AI_MODELS, RETIRED_AI_MODEL_SLUGS } from '../06-ai-models';
import { ModelTaskType } from '../ai-models/shared';
import * as globalSetting from '../11-global-setting';
import { SYSTEM_HARNESS_POLICY_TEXT_DEFAULTS } from '../13-harness-policy';
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
// 1. AiTaskDefault SYSTEM seed
// =============================================================================

describe('AiTaskDefault SYSTEM seed', () => {
  const TASK_KEY_TO_TASK_TYPE: Record<string, string> = {
    'guardrail.validate': ModelTaskType.GUARDRAIL,
    'nlp.ner': 'TOKEN_CLASSIFICATION',
    'nlp.classification': 'TEXT_CLASSIFICATION',
    // TEXT generation routing keys.
    'text.live': 'TEXT_GENERATION',
    'text.finalize': 'TEXT_GENERATION',
    // BUG-018 — prompt-template Test routing, independent of harness.
    'text.test': 'TEXT_GENERATION',
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

  const loadModule = async () =>
    import('../16-ai-task-default') as Promise<{
      SYSTEM_AI_TASK_DEFAULTS: Array<{
        id: string;
        tenantId: string;
        taskKey: string;
        modelSlug: string;
      }>;
      seedAiTaskDefault: (client: unknown) => Promise<{ created: number; skipped: number }>;
    }>;

  it('seeds exactly the twelve SYSTEM task defaults with deterministic ids', async () => {
    const { SYSTEM_AI_TASK_DEFAULTS } = await loadModule();
    const byKey = new Map(SYSTEM_AI_TASK_DEFAULTS.map((r) => [r.taskKey, r]));
    expect(SYSTEM_AI_TASK_DEFAULTS.length).toBe(12);
    expect(byKey.get('guardrail.validate')?.modelSlug).toBe('granite-guardian-4.1-8b');
    expect(byKey.get('nlp.ner')?.modelSlug).toBe('medical-ner');
    // nlp.classification is the doc-type classifier (fail-closed
    // placeholder); the diagnosis suggester moved to nlp.diagnosis.
    expect(byKey.get('nlp.classification')?.modelSlug).toBe('nlp-doc-type-classifier');
    expect(byKey.get('nlp.diagnosis')?.modelSlug).toBe('symps-disease-bert-v3-c41');
    // TEXT live/finalize routing. OWNER DIRECTIVE 2026-09-03 :
    // every text-generation task routes to LM Studio `gemma-4-e2b-it-qat`
    // (owner correction 2026-09-03,: E2B is the ONLY LM Studio model).
    expect(byKey.get('text.live')?.modelSlug).toBe('lms-gemma-4-e2b-it-qat');
    expect(byKey.get('text.finalize')?.modelSlug).toBe('lms-gemma-4-e2b-it-qat');
    // BUG-018 — the prompt-template Test key. Seeded so the Test path
    // resolves through AiTaskDefault ALONE and never falls through to the
    // harness `text.finalize` cascade to find a model. Same model as the
    // clinical paths, or the Test button answers a question nobody asked.
    expect(byKey.get('text.test')?.modelSlug).toBe('lms-gemma-4-e2b-it-qat');
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
    expect(new Set(SYSTEM_AI_TASK_DEFAULTS.map((r) => r.id)).size).toBe(12);
  });

  it('references catalogue slugs whose taskType matches the task key (or a retired slug, which fails closed)', async () => {
    const { SYSTEM_AI_TASK_DEFAULTS } = await loadModule();
    SYSTEM_AI_TASK_DEFAULTS.forEach((row) => {
      const model = bySlug(row.modelSlug);
      if (!model) {
        // TASK-860 retired the DISABLED `nlp-doc-type-classifier` placeholder
        // that `nlp.classification` pointed at. A retired selection resolves
        // to no ENABLED model — the same fail-closed 503 the DISABLED row
        // produced — so the reference is tolerated ONLY through the ledger.
        // `16-ai-task-default.ts` itself is retired by TASK-862.
        expect(RETIRED_AI_MODEL_SLUGS, `AiTaskDefault ${row.taskKey} references unknown slug ${row.modelSlug}`).toContain(row.modelSlug);
        return;
      }
      expect(model.taskType).toBe(TASK_KEY_TO_TASK_TYPE[row.taskKey]);
    });
  });

  it('is CREATE-ONLY: never overwrites an existing (tenant, taskKey) row', async () => {
    const { seedAiTaskDefault } = await loadModule();
    const client = {
      aiTaskDefault: {
        findFirst: vi.fn(async () => ({ id: 'existing', modelSlug: 'admin-chosen' })),
        create: vi.fn(),
        update: vi.fn(),
      },
    };
    const result = await seedAiTaskDefault(client as never);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(12);
    expect(client.aiTaskDefault.create).not.toHaveBeenCalled();
    expect(client.aiTaskDefault.update).not.toHaveBeenCalled();
  });

  it('creates the missing rows on a cold seed (system user as creator)', async () => {
    const { seedAiTaskDefault } = await loadModule();
    const created: Array<{ data: Record<string, unknown> }> = [];
    const client = {
      aiTaskDefault: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args);
          return args.data;
        }),
      },
    };
    const result = await seedAiTaskDefault(client as never);
    expect(result.created).toBe(12);
    created.forEach(({ data }) => {
      expect(data.tenantId).toBe(SYSTEM_TENANT_ID);
      expect(data.createdBy).toBe(SYSTEM_USER_ID);
    });
  });
});

// =============================================================================
// 2. Companion seeds — HarnessPolicy default + GlobalSetting retirement + RBAC
// =============================================================================

describe('companion seed updates', () => {
  it('moves the SYSTEM HarnessPolicy TEXT default to gemma-4-e2b-it-qat (provider lm-studio)', () => {
    expect(SYSTEM_HARNESS_POLICY_TEXT_DEFAULTS.textProvider).toBe('lm-studio');
    expect(SYSTEM_HARNESS_POLICY_TEXT_DEFAULTS.textModel).toBe('gemma-4-e2b-it-qat');
  });

  it('keeps the new TEXT default resolvable against the registry (lm-studio row, matching sourceUri)', () => {
    const row = catalog.find((m) => m.provider === 'lm-studio' && m.sourceUri === SYSTEM_HARNESS_POLICY_TEXT_DEFAULTS.textModel);
    expect(row).toBeDefined();
    expect(row?.slug).toBe('lms-gemma-4-e2b-it-qat');
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

    // 7 = the original six superseded keys + `smr/smr-azure-deployment` (D-740-1
    // moved that key to the `text` namespace, so the old row must be swept too).
    expect(client.globalSetting.updateMany).toHaveBeenCalledTimes(RETIRED_GLOBAL_SETTING_KEYS!.length);
    expect(client.globalSetting.updateMany).toHaveBeenCalledTimes(7);
    expect(result.retired).toBe(14);
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

  it('grants tenant admins read+manage on AiTaskDefault (tenant-scoped, TenantTtsConfig pattern)', () => {
    const tenantFullAccess = DEFAULT_POLICIES.find((p) => p.name === 'tenant-full-access');
    const rule = tenantFullAccess?.rules.find((r) => (r as { subject?: string }).subject === 'AiTaskDefault');
    expect(rule).toBeDefined();
    const actions = Array.isArray(rule?.action) ? rule?.action : [rule?.action];
    expect(actions).toContain('read');
    expect(actions).toContain('manage');
    const conditions = (rule as { conditions?: unknown } | undefined)?.conditions;
    expect(JSON.stringify(conditions)).toContain('${context.tenantId}');
  });
});
