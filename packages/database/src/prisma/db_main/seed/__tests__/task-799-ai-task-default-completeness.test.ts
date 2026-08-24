/**
 * TASK-799 Round 5 lane D — every DECLARED AI task key has a seeded platform default.
 *
 * THE DEFECT THIS EXISTS TO PREVENT. `AI_TASK_KEYS`
 * (`packages/applications/src/services/ai-task-default/constants.ts`) is the
 * registry of AI tasks whose model is selected through an `AiTaskDefault` row.
 * Every one of them also gets a `models.<taskKey>` descriptor, and every one of
 * those descriptors is `failMode: 'closed'`. A key that is declared but has NO
 * SYSTEM-tenant seed row therefore does not degrade — it 503s, forever, on a
 * platform that looks fully configured. Worse, `nlp.*` and `harness.*` resolve
 * SYSTEM-ONLY (decision D-4: platform-shared, no tenant BYO), so for those a
 * tenant cannot even repair it with a row of its own: the capability is
 * PERMANENTLY unusable rather than merely unconfigured.
 *
 * Three keys were in exactly that state when this test was written
 * (`nlp.sentiment`, `nlp.toxicity`, `vlm.extract`). Adding the rows fixes the
 * symptom; this test fixes the cause, because the next key added to
 * `AI_TASK_KEYS` cannot reach the branch unseeded and unexplained.
 *
 * ## Why the registry is PARSED and the seed is IMPORTED
 *
 * `packages/database` does not depend on `@arcaai/applications` (the dependency
 * runs the other way), so the two halves cannot both be imported. The half that
 * is parsed is deliberately the SIMPLER one: `AI_TASK_KEYS` is a flat
 * `as const` array of string literals, whereas the seed rows are objects with
 * interleaved commentary. `readFileSync` over a sibling package's source is the
 * established shape here — see `seed-pipeline-completeness.test.ts`.
 *
 * A silent parse failure would make this test pass vacuously, which is the one
 * way a guard like this fails dangerously. The anchor assertions below exist to
 * make that impossible.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SYSTEM_TENANT_ID } from '../00-constants';
import { SEEDED_TASK_KEYS_NOT_IN_REGISTRY, SYSTEM_AI_TASK_DEFAULTS, SYSTEM_TASK_DEFAULT_EXEMPTIONS } from '../16-ai-task-default';

const CONSTANTS_PATH = join(__dirname, '../../../../../../applications/src/services/ai-task-default/constants.ts');

/** The `AI_TASK_KEYS` string literals, read from the applications package's source. */
function declaredTaskKeys(): string[] {
  const src = readFileSync(CONSTANTS_PATH, 'utf8');
  const block = /export const AI_TASK_KEYS = \[([\s\S]*?)\] as const;/.exec(src);
  if (!block) {
    throw new Error(
      `Could not locate the AI_TASK_KEYS array in ${CONSTANTS_PATH}. The registry moved or was reshaped; fix this parser rather than deleting the guard.`,
    );
  }
  // Strip comments BEFORE extracting quoted strings. The array is interleaved
  // with prose, and an apostrophe in it (`guardrail's own SQL`) reads as a
  // quoted literal to a naive scan — which manufactured a phantom "task key"
  // out of a comment fragment and failed this guard for a gap that did not
  // exist. A guard that cries wolf over its own documentation gets deleted, so
  // the parser has to ignore commentary rather than the comments being written
  // around the parser.
  const code = block[1]!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...code.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

const DECLARED = declaredTaskKeys();
const SEEDED_SYSTEM_KEYS = SYSTEM_AI_TASK_DEFAULTS.filter((r) => r.tenantId === SYSTEM_TENANT_ID).map((r) => r.taskKey);

describe('AI task-key registry <-> seed parity', () => {
  // ── anti-vacuity ────────────────────────────────────────────────────────
  // Without these, a parser that silently returns [] turns every assertion
  // below into `expect([]).toEqual([])` and the guard reports success while
  // checking nothing.
  it('parses a plausible, non-empty registry (guards against a vacuous pass)', () => {
    expect(DECLARED.length).toBeGreaterThanOrEqual(10);
    expect(DECLARED).toContain('guardrail.validate');
    expect(DECLARED).toContain('text.finalize');
    expect(DECLARED).toContain('harness.judge');
    expect(new Set(DECLARED).size).toBe(DECLARED.length);
  });

  // ── the invariant ───────────────────────────────────────────────────────
  it('every declared task key has a SYSTEM seed row, or a DECLARED exemption saying why not', () => {
    const unaccounted = DECLARED.filter((key) => !SEEDED_SYSTEM_KEYS.includes(key) && !(key in SYSTEM_TASK_DEFAULT_EXEMPTIONS));

    expect(
      unaccounted,
      'these AI task keys are declared with a fail-closed `models.*` descriptor but have no SYSTEM AiTaskDefault seed row — ' +
        'they 503 forever. Seed a row, or add an entry to SYSTEM_TASK_DEFAULT_EXEMPTIONS explaining why the absence is correct.',
    ).toEqual([]);
  });

  it('no exemption is stale — an exempted key must not also be seeded', () => {
    const contradictory = Object.keys(SYSTEM_TASK_DEFAULT_EXEMPTIONS).filter((key) => SEEDED_SYSTEM_KEYS.includes(key));
    expect(contradictory, 'these keys claim an exemption AND carry a seed row; delete the exemption').toEqual([]);
  });

  it('no exemption names a task key the registry does not declare', () => {
    const unknown = Object.keys(SYSTEM_TASK_DEFAULT_EXEMPTIONS).filter((key) => !DECLARED.includes(key));
    expect(unknown, 'these exemptions name keys absent from AI_TASK_KEYS; the key was renamed or removed').toEqual([]);
  });

  it('every exemption carries a real reason, not a placeholder', () => {
    for (const [key, reason] of Object.entries(SYSTEM_TASK_DEFAULT_EXEMPTIONS)) {
      expect(reason.length, `exemption for '${key}' must explain itself`).toBeGreaterThan(40);
    }
  });

  // ── the mirror: seeded but unregistered ─────────────────────────────────
  // `apps/guardrail` reads AiTaskDefault rows by task_key over its own SQL
  // connection (the sanctioned peer-service exception,
  // `apps/guardrail/src/guardrail/core/tenant_config.py:128`), so a row can be
  // load-bearing at runtime while `AI_TASK_KEYS` never declares it. Such a row
  // works, but `AiTaskDefaultService.assertKnownTaskKey` rejects the key, so no
  // administrator can read or change it through the gateway and it has no
  // `models.*` descriptor to appear in the settings catalog.
  it('a seeded task key that the registry does not declare is DECLARED as such, never silent', () => {
    const undeclared = SEEDED_SYSTEM_KEYS.filter((key) => !DECLARED.includes(key));
    expect(
      undeclared.sort(),
      'these keys are seeded but absent from AI_TASK_KEYS — unmanageable through the admin API. ' +
        'Register them, or list them in SEEDED_TASK_KEYS_NOT_IN_REGISTRY with the reason.',
    ).toEqual([...SEEDED_TASK_KEYS_NOT_IN_REGISTRY].sort());
  });

  it('every seed row targets the SYSTEM tenant — a customer-tenant row would shadow the platform default forever', () => {
    const foreign = SYSTEM_AI_TASK_DEFAULTS.filter((r) => r.tenantId !== SYSTEM_TENANT_ID).map((r) => `${r.taskKey}@${r.tenantId}`);
    expect(foreign).toEqual([]);
  });

  it('seed rows are unique per (tenantId, taskKey)', () => {
    const seen = SYSTEM_AI_TASK_DEFAULTS.map((r) => `${r.tenantId}::${r.taskKey}`);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('seed row ids are unique', () => {
    const ids = SYSTEM_AI_TASK_DEFAULTS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
