import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AiTaskKind } from '@arcaai/domains';
import { describe, expect, it } from 'vitest';

import { AI_TASK_KEYS, AI_TASK_KIND_BY_TASK_KEY, resolveAiTaskKind } from '../constants';

/**
 * The canonical AI task taxonomy (moved from `ai-task-default/__tests__` by
 * TASK-881; the `AiTaskDefault` facade is gone, the taxonomy is the routing
 * policy's).
 *
 * The load-bearing test here is the migration-parity one: the backfill in
 * `task_843_ai_task_taxonomy/migration.sql` hand-writes the same taskKey →
 * kind mapping in SQL, and nothing but this test stops the two copies
 * drifting for the keys that still exist. The five `text.*` keys were retired
 * by TASK-881 (text generation selects through the assigned agent), so the SQL
 * carries arms the vocabulary no longer does — those are named explicitly,
 * never absorbed.
 */

const MIGRATION_SQL = join(
  __dirname,
  '../../../../../database/src/prisma/db_main/migrations/20260901051803_task_843_ai_task_taxonomy/migration.sql',
);

/** Keys the migration classified that TASK-881 retired from the vocabulary. */
const RETIRED_IN_SQL = ['text.live', 'text.finalize', 'text.test', 'text.live.fallback', 'text.finalize.fallback'] as const;

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

describe('AI task taxonomy', () => {
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

  it('returns null for the retired text keys — they are not vocabulary any more', () => {
    for (const key of RETIRED_IN_SQL) expect(resolveAiTaskKind(key), key).toBeNull();
  });

  it('classifies the two task keys that live outside AI_TASK_KEYS', () => {
    // `nlp.topic` / `nlp.intent` are declared in tenant-nlp-task-instructions
    // as instruction-CONTENT keys; their model selection is an open governance
    // gap `assertKnownTaskKey` still rejects, so the taxonomy accounts for them
    // without widening the vocabulary.
    expect(resolveAiTaskKind('nlp.topic')).toBe(AiTaskKind.TEXT_CLASSIFICATION);
    expect(resolveAiTaskKind('nlp.intent')).toBe(AiTaskKind.TEXT_CLASSIFICATION);
  });

  it('keeps TEXT_GENERATION bound through the judge alone', () => {
    // The generation plane's only routing-policy key. `text.*` was one KIND
    // and five SELECTIONS until TASK-881; the kind survives on this key.
    expect(AI_TASK_KIND_BY_TASK_KEY['harness.judge']).toBe(AiTaskKind.TEXT_GENERATION);
  });

  it('does not collapse NER and PII, which share a ModelTaskType', () => {
    // Both are `ModelTaskType.TOKEN_CLASSIFICATION`. If the taxonomy were keyed
    // on model shape they would share a binding — they must not.
    expect(AI_TASK_KIND_BY_TASK_KEY['nlp.ner']).not.toBe(AI_TASK_KIND_BY_TASK_KEY['guardrail.pii']);
  });

  it('agrees with the SQL backfill in the task_843 migration for every surviving key, and names exactly the retired ones', () => {
    const sql = readFileSync(MIGRATION_SQL, 'utf8');
    const fromSql = parseMigrationCase(sql);

    const fromTs: Record<string, string> = { ...AI_TASK_KIND_BY_TASK_KEY, 'nlp.topic': AiTaskKind.TEXT_CLASSIFICATION, 'nlp.intent': AiTaskKind.TEXT_CLASSIFICATION };

    const surviving = Object.fromEntries(Object.entries(fromSql).filter(([key]) => !(RETIRED_IN_SQL as readonly string[]).includes(key)));
    expect(surviving).toEqual(fromTs);

    // The arms the SQL still carries but the vocabulary does not are exactly
    // the five text keys — a sixth would be a silent retirement.
    const onlyInSql = Object.keys(fromSql).filter((key) => !(key in fromTs));
    expect(onlyInSql.sort()).toEqual([...RETIRED_IN_SQL].sort());
  });

  it('applied the identical CASE to AiTaskDefault and AiRoutingPolicy', () => {
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
        // No routing key: served by a provider's NATIVE endpoint (Sarvam),
        // not by selecting a model. OD-8, 2026-09-01.
        AiTaskKind.TRANSLATION,
        // Selected through the SPEECH_TO_TEXT agent (TASK-861).
        AiTaskKind.SPEECH_TO_TEXT,
        // Selected through the TEXT_TO_SPEECH agent (TASK-879).
        AiTaskKind.TEXT_TO_SPEECH,
        // Selected per-connection (`ProviderService = 'embeddings'`); no task
        // key exists yet.
        AiTaskKind.EMBEDDING,
      ].sort(),
    );
  });
});
