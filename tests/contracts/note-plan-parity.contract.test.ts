/**
 * TASK-1045 — the NotePlan v1 / CoverageResult v1 wire contract, TypeScript half.
 *
 * `tests/contracts/note-plan.fixture.json` is pinned: the gateway composes plans and the harness
 * executes them, and both sides parse every case in that file. This test proves the TypeScript
 * schemas accept every case byte for byte (strict — an extra or missing field on either side
 * fails), and that the conventions the composer hard-codes match the ones the fixture states.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  NOTE_BLOCK_ROLES,
  NOTE_INPUT_EXCEEDS_CONTEXT,
  NOTE_PLAN_EXCLUDED_ITEM_TYPES,
  NOTE_PLAN_MAX_CALLS,
  NOTE_PLAN_MODES,
  NOTE_PLAN_REDIS_PREFIX,
  NOTE_PLAN_STRATEGIES,
  NOTE_PLAN_TTL_SECONDS,
  NOTE_COVERAGE_STATUSES,
  NOTE_GAP_KINDS,
  NOTE_TOKENIZER_MODES,
  coverageResultV1Schema,
  notePlanEnvelopeSchema,
  notePlanRefSchema,
  notePlanV1Schema,
} from '../../packages/applications/src/services/consultation/note-composition/note-plan.types';

const fixture = JSON.parse(readFileSync(join(__dirname, 'note-plan.fixture.json'), 'utf8'));

describe('TASK-1045 — NotePlan v1 parity with the pinned fixture', () => {
  it.each(fixture.notePlans.map((entry: { name: string; plan: unknown }) => [entry.name, entry.plan]))('parses note plan %s', (_name, plan) => {
    const parsed = notePlanV1Schema.safeParse(plan);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(true);
    // Round trip: nothing is dropped or invented by the schema.
    expect(parsed.success && parsed.data).toEqual(plan);
  });

  it.each(fixture.coverageResults.map((entry: { name: string; result: unknown }) => [entry.name, entry.result]))(
    'parses coverage result %s',
    (_name, result) => {
      const parsed = coverageResultV1Schema.safeParse(result);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(true);
      expect(parsed.success && parsed.data).toEqual(result);
    },
  );

  it('parses the harness hand-off ref', () => {
    expect(notePlanRefSchema.parse(fixture.harnessDelivery.handoffRef)).toEqual(fixture.harnessDelivery.handoffRef);
  });

  it('refuses a plan with an unknown field (strict on both sides)', () => {
    const plan = { ...fixture.notePlans[0].plan, extra: true };
    expect(notePlanV1Schema.safeParse(plan).success).toBe(false);
  });

  it('accepts coverage.criticalFacts = null (ledger not ready ⇒ unchecked), as the conventions state', () => {
    const plan = fixture.notePlans[0].plan;
    expect(notePlanV1Schema.safeParse({ ...plan, coverage: { ...plan.coverage, criticalFacts: null } }).success).toBe(true);
  });

  it('refuses a plan with no headings (the executor needs one per call section)', () => {
    expect(notePlanV1Schema.safeParse({ ...fixture.notePlans[0].plan, headings: [] }).success).toBe(false);
  });

  it('parses the delivery envelope with preserved section text', () => {
    const plan = fixture.notePlans[2].plan;
    const envelope = { plan, preservedSections: plan.preserve.sectionKeys.map((key: string) => ({ key, content: `${key} text` })) };
    expect(notePlanEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it('refuses more than the pinned maximum of calls', () => {
    const plan = fixture.notePlans[0].plan;
    const calls = Array.from({ length: NOTE_PLAN_MAX_CALLS + 1 }, (_, i) => ({ ...plan.calls[0], callId: `c${i}` }));
    expect(notePlanV1Schema.safeParse({ ...plan, calls }).success).toBe(false);
  });

  it('states the same conventions as the fixture', () => {
    const c = fixture.conventions;
    expect([...NOTE_BLOCK_ROLES]).toEqual(c.blockOrder);
    expect(NOTE_PLAN_MAX_CALLS).toBe(c.maxCalls);
    expect([...NOTE_PLAN_EXCLUDED_ITEM_TYPES]).toEqual(c.excludedItemTypes);
    expect([...NOTE_TOKENIZER_MODES]).toEqual(c.tokenizerModes);
    expect([...NOTE_PLAN_STRATEGIES]).toEqual(c.strategies);
    expect([...NOTE_PLAN_MODES]).toEqual(c.modes);
    expect(NOTE_INPUT_EXCEEDS_CONTEXT).toBe(c.failClosedErrorCode);
    expect([...NOTE_COVERAGE_STATUSES]).toEqual(c.coverageStatuses);
    expect([...NOTE_GAP_KINDS]).toEqual(c.gapKinds);
    expect(`${NOTE_PLAN_REDIS_PREFIX}<planId>`).toBe(fixture.harnessDelivery.redisKey);
    expect(NOTE_PLAN_TTL_SECONDS).toBe(fixture.harnessDelivery.ttlSeconds);
  });
});
