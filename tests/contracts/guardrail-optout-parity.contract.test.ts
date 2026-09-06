/**
 * TASK-890 §3.14 — guardrail opt-out precedence, cross-language parity (TypeScript half).
 *
 * The gateway folds the decision for the realtime `core.agent` lane, for
 * `POST /agents/:slug/invocations` and for the publish-time `GUARDRAIL_OPTED_OUT` finding; the
 * harness folds it for the durable lane. Both execute the SAME node, so a divergence means one
 * lane screens a call the other does not — a safety difference no suite outside this fixture
 * would see. The Python half is
 * `apps/harness/src/harness/tests/unit/temporal/interpreter/test_guardrail_optout_parity.py`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The repo root has no `@arcaai/workflow-contract` dependency; the contract is imported from
// SOURCE by path, the shape the seed suites already use for the same reason.
const CONTRACT_SRC = path.resolve(__dirname, '../../packages/workflow-contract/src/guardrail-optout.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { GUARDRAIL_DECISION_SOURCES, resolveGuardrailDecision } = contract;

interface Case {
  name: string;
  input: { node: boolean | null; workflow: boolean | null; agent: boolean | null };
  expected: { enabled: boolean; source: string };
}

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'guardrail-optout.fixture.json'), 'utf-8')) as { cases: Case[] };

describe('guardrail-optout fixture — not vacuous', () => {
  it('covers all eight level combinations that change the answer, and every source', () => {
    expect(fixture.cases).toHaveLength(8);
    const names = fixture.cases.map((entry) => entry.name);
    expect(new Set(names).size).toBe(8);
    const inputs = new Set(fixture.cases.map((entry) => JSON.stringify(entry.input)));
    expect(inputs.size).toBe(8);
    // Both outcomes and every source appear — a fixture of eight `true`s would prove nothing.
    expect(new Set(fixture.cases.map((entry) => entry.expected.enabled))).toEqual(new Set([true, false]));
    expect([...new Set(fixture.cases.map((entry) => entry.expected.source))].sort()).toEqual([...GUARDRAIL_DECISION_SOURCES].sort());
  });
});

describe('resolveGuardrailDecision over the shared fixture', () => {
  it.each(fixture.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(resolveGuardrailDecision(entry.input)).toEqual(entry.expected);
  });
});
