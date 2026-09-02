/**
 * TASK-858 D4/D5 — every text-generation task routes to LM Studio
 * `gemma-4-e4b-it-qat`, on a cold seed AND on an already-seeded database.
 *
 * ## Why the migration is tested here, as text
 *
 * `seedAiTaskDefault` is CREATE-ONLY: it never overwrites an existing
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
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SYSTEM_AI_TASK_DEFAULTS } from '../16-ai-task-default';
import { AUDIO_AI_MODELS } from '../ai-models/audio';
import { LLM_AI_MODELS } from '../ai-models/llm';
import { SYSTEM_TENANT_ID } from '../00-constants';

const TARGET_SLUG = 'lms-gemma-4-e4b-it-qat';
const TEXT_TASK_KEYS = ['text.live', 'text.finalize', 'text.test', 'harness.judge'] as const;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../../migrations');
const MIGRATION_SUFFIX = '_task_858_text_defaults_gemma_e4b';

const byKey = new Map(SYSTEM_AI_TASK_DEFAULTS.map((row) => [row.taskKey, row]));

describe('TASK-858 D4 — the SYSTEM text-generation defaults', () => {
  it.each(TEXT_TASK_KEYS)('%s resolves to lms-gemma-4-e4b-it-qat', (taskKey) => {
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
    expect(model?.sourceUri).toBe('gemma-4-e4b-it-qat');
  });

  it('judgement and documentation resolve ONE model identity, not two', () => {
    // Before this change `harness.judge` named `lms-gemma-4-e4b` (the
    // un-quantized `google/gemma-4-e4b`) while the `text.*` keys named the E2B
    // sibling — three different LM Studio identities across four keys that all
    // do text generation.
    expect(new Set(TEXT_TASK_KEYS.map((k) => byKey.get(k)?.modelSlug)).size).toBe(1);
  });
});

describe('TASK-858 D5 — the data migration that moves an already-seeded database', () => {
  const folder = readdirSync(MIGRATIONS_DIR).find((name) => name.endsWith(MIGRATION_SUFFIX));

  it('exists, with a timestamped folder name that sorts with the ledger', () => {
    expect(folder, `no migration folder ending in ${MIGRATION_SUFFIX}`).toBeDefined();
    // Prisma applies EVERY subdirectory containing a `migration.sql` and orders
    // them by name, so a non-timestamped prefix pollutes the ledger permanently.
    expect(folder).toMatch(/^\d{14}_task_858_text_defaults_gemma_e4b$/);
  });

  const sql = () => readFileSync(path.join(MIGRATIONS_DIR, folder!, 'migration.sql'), 'utf8');

  it('is pure DML — no schema change', () => {
    const statements = sql().toUpperCase();
    for (const ddl of ['CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'CREATE INDEX', 'ALTER TYPE']) {
      expect(statements, `migration contains ${ddl}`).not.toContain(ddl);
    }
    // …and it never deletes.
    for (const destructive of ['DELETE FROM', 'TRUNCATE', 'DROP ']) {
      expect(statements).not.toContain(destructive);
    }
  });

  it('moves every one of the four keys to the new slug', () => {
    const statements = sql();
    for (const taskKey of TEXT_TASK_KEYS) expect(statements).toContain(`'${taskKey}'`);
    expect(statements).toContain(`'${TARGET_SLUG}'`);
  });

  it('touches the SYSTEM tenant ONLY', () => {
    // A tenant's own `text.*` row is that tenant's opinion and outranks the
    // platform default; rewriting it here would invert the tenant -> SYSTEM
    // cascade the whole config plane rests on.
    const statements = sql();
    const updates = statements.split(/UPDATE\s+/i).slice(1);
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(update).toContain(`"tenantId" = '${SYSTEM_TENANT_ID}'`);
    }
  });

  it('is GUARDED on the old value, so an operator’s own choice is never clobbered', () => {
    // Same reason `seedAiTaskDefault` is create-only. This is also what makes
    // the migration idempotent: a second run matches nothing.
    const statements = sql();
    expect(statements).toContain(`"modelSlug" = 'lms-gemma-4-e2b-it-qat'`);
    // `harness.judge` came from a DIFFERENT old slug, so it needs its own guard
    // rather than sharing the three-key statement.
    expect(statements).toContain(`"modelSlug" = 'lms-gemma-4-e4b'`);
  });

  it('bumps the OCC counter it is writing under', () => {
    // `_version` is the optimistic-concurrency column; a data migration that
    // rewrites a row without moving it leaves a stale ETag looking fresh.
    expect(sql()).toContain('"_version" = "_version" + 1');
  });
});

describe('TASK-858 D1 — the q8_0 medical ASR row rides the catalog replication', () => {
  it('is a SYSTEM row in AUDIO_AI_MODELS, so `backfillCustomerTenantAiModels` clones it', () => {
    // Replication to customer tenants is not a per-model decision: the backfill
    // walks DEFAULT_AI_MODELS (= AUDIO + LLM + NLP + TTS) for every seeded
    // customer tenant, and `TenantService.provisionTenantModelCatalog` does the
    // same for new tenants. Being in this array IS the mechanism.
    const row = AUDIO_AI_MODELS.find((m) => m.slug === 'whisper-large-en-medical-260726-merged-gguf-q8_0');
    expect(row).toBeDefined();
    expect(row?.tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('is distinguishable from its f16 sibling by computeType alone', () => {
    // Same repo, same format, same architecture — `computeType` is what
    // `whisper_cpp_loader._select_gguf_file` matches the GGUF FILENAME on, so
    // it is the only field that may differ meaningfully, and it must.
    const f16 = AUDIO_AI_MODELS.find((m) => m.slug === 'whisper-large-en-medical-260726-merged-gguf')!;
    const q8 = AUDIO_AI_MODELS.find((m) => m.slug === 'whisper-large-en-medical-260726-merged-gguf-q8_0')!;
    expect(q8.sourceUri).toBe(f16.sourceUri);
    expect(q8.format).toBe(f16.format);
    expect(f16.computeType).toBe('f16');
    expect(q8.computeType).toBe('q8_0');
    expect(q8.id).not.toBe(f16.id);
  });
});
