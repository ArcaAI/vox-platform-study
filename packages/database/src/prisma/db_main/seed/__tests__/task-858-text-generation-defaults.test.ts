/**
 * /D5 — every text-generation task routes to LM Studio
 * `gemma-4-e2b-it-qat` (owner correction 2026-09-03: google/gemma-4-E2B-it-qat-q4_0-gguf is THE LM Studio model), on a cold seed AND on an already-seeded database.
 *
 * ## Why the migration is tested here, as text
 *
 * `seedAiRoutingPolicy` (TASK-862 — the elected `AiRoutingPolicy` defaults that
 * replaced `seedAiTaskDefault`) is CREATE-ONLY: it never overwrites an existing
 * `(tenantId, taskKey)` row, because the platform default is admin-tunable and
 * a re-seed must not clobber somebody's choice. That is right, and it means the
 * seed edit alone reaches ONLY a database that has never been seeded. Every
 * existing one keeps the old rows unless a migration moves them.
 *
 * So the seed change is half the deliverable and the migration is the other
 * half, and a suite that checked only the seed would report green while every
 * real database still ran E2B. There is no live database here — these tests
 * read the committed SQL and assert the properties that make it safe to run:
 * it targets the SYSTEM tenant only, it is guarded on the OLD value so an
 * operator's own choice survives, and it is therefore idempotent.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SYSTEM_TASK_DEFAULT_ROUTING } from '../16-ai-routing-policy';
import { AUDIO_AI_MODELS } from '../ai-models/audio';
import { LLM_AI_MODELS } from '../ai-models/llm';
import { SYSTEM_TENANT_ID } from '../00-constants';

const TARGET_SLUG = 'lms-gemma-4-e2b-it-qat';
// TASK-881: the three `text.*` elections are gone (text selects through the assigned agent);
// `harness.judge` is the one text-generation routing election left.
const TEXT_TASK_KEYS = ['harness.judge'] as const;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../../migrations');
const MIGRATION_SUFFIX = '_task_858_text_defaults_gemma_e4b';

const byKey = new Map(SYSTEM_TASK_DEFAULT_ROUTING.map((row) => [row.taskKey, row]));

describe(' D4 — the SYSTEM text-generation defaults', () => {
  it.each(TEXT_TASK_KEYS)('%s resolves to lms-gemma-4-e2b-it-qat', (taskKey) => {
    const row = byKey.get(taskKey);
    expect(row, `${taskKey} is not seeded`).toBeDefined();
    expect(row?.modelSlug).toBe(TARGET_SLUG);
    expect(row?.tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('the slug it names is a real catalogued model, on the right provider', () => {
    // A task default pointing at a slug no `AiModel` carries resolves to
    // nothing at runtime and fails closed — a silent 503 on every summary.
    const model = LLM_AI_MODELS.find((m) => m.slug === TARGET_SLUG);
    expect(model, `${TARGET_SLUG} is not in the model catalog`).toBeDefined();
    expect(model?.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(model?.provider).toBe('lm-studio');
    // The WIRE id LM Studio serves, not the HF repo path: `sourceUri` is what
    // the adapter puts on the request, and an id the instance has never served
    // 404s every call (which is exactly how `lms-gemma-4-e4b` earned its
    // correction in 2026-08).
    expect(model?.sourceUri).toBe('gemma-4-e2b-it-qat');
  });

  it('the retired text.* elections are not seeded', () => {
    for (const key of ['text.live', 'text.finalize', 'text.test']) expect(byKey.has(key), key).toBe(false);
  });
});

// (a data migration moving already-seeded databases to the E4B model) was
// REMOVED on 2026-09-03: the owner corrected the LM Studio model to
// google/gemma-4-E2B-it-qat-q4_0-gguf, which is what the cold seed always named, so
// there is nothing for an existing database to migrate to. The migration never left
// this checkout.
