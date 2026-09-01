import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AiTaskKind } from '@arcaai/domains';
import { describe, expect, it } from 'vitest';

import { AI_TASK_KEYS, AI_TASK_KIND_BY_TASK_KEY, resolveAiTaskKind } from '../constants';

/**
 * TASK-843 — the canonical AI task taxonomy.
 *
 * The load-bearing test here is the LAST one: the backfill in
 * `task_843_ai_task_taxonomy/migration.sql` hand-writes the same taskKey → kind
 * mapping in SQL, and nothing but this test stops the two copies drifting. A
 * drift would not fail a build — it would quietly classify rows one way in the
 * database and another way in the service.
 */

const MIGRATION_SQL = join(
  __dirname,
  '../../../../../database/src/prisma/db_main/migrations/20260901051803_task_843_ai_task_taxonomy/migration.sql',
);

/**
 * Reads the `CASE` arms of the migration's first backfill UPDATE back into a
 * `taskKey → AiTaskKind` map. Both UPDATE statements carry an identical CASE,
 * which the "both backfills agree" test below pins.
 */
function parseMigrationCase(sql: string): Record<string, string> {
  const body = sql.slice(sql.indexOf('UPDATE "core"."AiTaskDefault"'), sql.indexOf('UPDATE "core"."AiRoutingPolicy"'));
  const mapping: Record<string, string> = {};

  for (const line of body.split('\n')) {
    const arm = /^\s*WHEN "taskKey" (?:=|IN) (.+?) THEN '([A-Z_]+)'\s*$/.exec(line);
    if (!arm) continue;
    const [, keysExpr, kind] = arm;
    for (const [, key] of keysExpr.matchAll(/'([^']+)'/g)) {
      mapping[key] = kind;
    }
  }
  return mapping;
}

describe('TASK-843 — AI task taxonomy', () => {
  it('classifies every declared task key', () => {
    const unclassified = AI_TASK_KEYS.filter((k) => !AI_TASK_KIND_BY_TASK_KEY[k]);
    expect(unclassified).toEqual([]);
  });

  it('maps only to real AiTaskKind members', () => {
    const members = new Set(Object.values(AiTaskKind));
    for (const kind of Object.values(AI_TASK_KIND_BY_TASK_KEY)) {
      expect(members).toContain(kind);
    }
  });

  it('returns null for an unknown key rather than guessing (selection fails closed)', () => {
    expect(resolveAiTaskKind('not.a.real.key')).toBeNull();
    expect(resolveAiTaskKind('')).toBeNull();
  });

  it('classifies the two task keys that live outside AI_TASK_KEYS', () => {
    // `nlp.topic` / `nlp.intent` are declared in tenant-nlp-task-instructions
    // but still resolve their MODEL through AiTaskDefault, so the taxonomy has
    // to account for them even though `assertKnownTaskKey` rejects them.
    expect(resolveAiTaskKind('nlp.topic')).toBe(AiTaskKind.TEXT_CLASSIFICATION);
    expect(resolveAiTaskKind('nlp.intent')).toBe(AiTaskKind.TEXT_CLASSIFICATION);
  });

  it('keeps text.live and text.finalize in one kind but two selections', () => {
    // Pins the granularity decision: `taskKind` is COARSER than `taskKey`, so a
    // "one default per task" constraint must key on `taskKey`. A partial unique
    // index on (tenantId, taskKind) would silently merge these two.
    expect(AI_TASK_KIND_BY_TASK_KEY['text.live']).toBe(AiTaskKind.TEXT_GENERATION);
    expect(AI_TASK_KIND_BY_TASK_KEY['text.finalize']).toBe(AiTaskKind.TEXT_GENERATION);
    expect(AI_TASK_KEYS).toContain('text.live');
    expect(AI_TASK_KEYS).toContain('text.finalize');
  });

  it('does not collapse NER and PII, which share a ModelTaskType', () => {
    // Both are `ModelTaskType.TOKEN_CLASSIFICATION`. If the taxonomy were keyed
    // on model shape they would share a binding — they must not.
    expect(AI_TASK_KIND_BY_TASK_KEY['nlp.ner']).not.toBe(AI_TASK_KIND_BY_TASK_KEY['guardrail.pii']);
  });

  it('agrees with the SQL backfill in the TASK-843 migration', () => {
    const sql = readFileSync(MIGRATION_SQL, 'utf8');
    const fromSql = parseMigrationCase(sql);

    const fromTs: Record<string, string> = { ...AI_TASK_KIND_BY_TASK_KEY, 'nlp.topic': AiTaskKind.TEXT_CLASSIFICATION, 'nlp.intent': AiTaskKind.TEXT_CLASSIFICATION };

    expect(fromSql).toEqual(fromTs);
  });

  it('applies the identical CASE to AiTaskDefault and AiRoutingPolicy', () => {
    const sql = readFileSync(MIGRATION_SQL, 'utf8');
    const arms = [...sql.matchAll(/^\s*WHEN "taskKey" (?:=|IN) (.+?) THEN '([A-Z_]+)'\s*$/gm)].map((m) => `${m[1]}=>${m[2]}`);
    const half = arms.length / 2;
    expect(half).toBeGreaterThan(0);
    expect(arms.slice(0, half)).toEqual(arms.slice(half));
  });

  it('leaves exactly the four unbound kinds unbound, and names them', () => {
    // A new enum member must be either classified against a task key or listed
    // here with a reason — otherwise it can be added and forgotten.
    const bound = new Set<string>(Object.values(AI_TASK_KIND_BY_TASK_KEY));
    const unbound = Object.values(AiTaskKind).filter((k) => !bound.has(k));
    expect(unbound.sort()).toEqual(
      [
        // No `AiTaskDefault` key: served by a provider's NATIVE endpoint
        // (Sarvam), not by selecting a model. OD-8, 2026-09-01.
        AiTaskKind.TRANSLATION,
        // Selected through AsrPipeline / TenantSttConfig until TASK-844.
        AiTaskKind.SPEECH_TO_TEXT,
        // Selected through TenantTtsConfig until TASK-844.
        AiTaskKind.TEXT_TO_SPEECH,
        // Selected per-connection (`ProviderService = 'embeddings'`); no task
        // key exists yet.
        AiTaskKind.EMBEDDING,
      ].sort(),
    );
  });
});
