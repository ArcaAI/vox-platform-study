/**
 * TASK-890 §3.2 — prompt-template grammar cross-language parity (TypeScript half).
 *
 * The gateway renders prompts with `renderTemplate` (`@arcaai/workflow-contract`, the realtime
 * `core.agent` lane, the prompt test-run, `/agents/:slug/invocations`) and the harness renders
 * the SAME node with `harness.temporal.interpreter.templating` on the durable lane. Before this
 * ticket those were two of six different grammars, so `{{trigger.patientAge}}` resolved on one
 * lane and was emitted as a literal on the other (§2.4). Both halves now read this ONE committed
 * fixture — the Python half is
 * `apps/harness/src/harness/tests/unit/temporal/interpreter/test_templating_parity.py`.
 *
 * The suite also asserts the fixture is NOT VACUOUS: a fixture that lost its cases would leave
 * both loaders green while proving nothing, which is the failure mode a parity gate exists to
 * prevent.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The repo root has no `@arcaai/workflow-contract` dependency (it is a workspace package, not a
// root one), so the contract is imported from SOURCE by path — the same shape the seed suites in
// `packages/database/src/prisma/db_main/seed/__tests__` use for exactly this reason.
const CONTRACT_SRC = path.resolve(__dirname, '../../packages/workflow-contract/src/template.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { PromptTemplateSyntaxError, PromptVariableUnresolvedError, renderTemplate, templateReferences } = contract;

interface RenderCase {
  name: string;
  template: string;
  scope: Record<string, unknown>;
  expected?: string;
  error?: 'PromptVariableUnresolved' | 'PromptTemplateSyntaxError';
}

interface ReferenceCase {
  name: string;
  template: string;
  expected: Array<{ path: string; hasDefault: boolean; offset: number }>;
}

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'prompt-template.fixture.json'), 'utf-8')) as {
  cases: RenderCase[];
  references: ReferenceCase[];
};

/** The names both loaders must carry — §3.2's minimum case list, by name. */
const REQUIRED_CASE_NAMES = [
  'dotted-resolution',
  'bare-name',
  'missing-path-errors',
  'default-applied',
  'default-not-applied-when-present',
  'escape',
  'value-with-braces-not-reparsed',
  'whitespace-tolerance',
  'object-value-json-sorted',
  'array-not-indexable',
  'null-is-missing',
  'unknown-filter-is-syntax-error',
  'unterminated-is-syntax-error',
  'prototype-key-not-variable',
  'nodes-namespace',
  'single-brace-is-literal',
] as const;

describe('prompt-template fixture — not vacuous', () => {
  it('carries every case §3.2 names, and both an expectation and an error case', () => {
    const names = fixture.cases.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of REQUIRED_CASE_NAMES) expect(names).toContain(required);
    expect(fixture.cases.filter((entry) => typeof entry.expected === 'string').length).toBeGreaterThanOrEqual(10);
    expect(fixture.cases.filter((entry) => typeof entry.error === 'string').length).toBeGreaterThanOrEqual(6);
    expect(fixture.references.length).toBeGreaterThan(0);
  });

  it('declares exactly one of `expected` / `error` per case', () => {
    for (const entry of fixture.cases) {
      expect(
        (typeof entry.expected === 'string' ? 1 : 0) + (typeof entry.error === 'string' ? 1 : 0),
        `case ${entry.name} declares neither or both`,
      ).toBe(1);
    }
  });
});

describe('renderTemplate over the shared fixture', () => {
  it.each(fixture.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    if (typeof entry.expected === 'string') {
      expect(renderTemplate(entry.template, entry.scope)).toBe(entry.expected);
      return;
    }
    const expectedError = entry.error === 'PromptTemplateSyntaxError' ? PromptTemplateSyntaxError : PromptVariableUnresolvedError;
    expect(() => renderTemplate(entry.template, entry.scope)).toThrow(expectedError);
  });
});

describe('templateReferences over the shared fixture', () => {
  it.each(fixture.references.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(templateReferences(entry.template)).toEqual(entry.expected);
  });
});
