/**
 * TASK-1036 §3.1 — "Derive v2": `deriveVariableDeclarations(content, existing)`.
 *
 * The byte-level contract lives in `tests/contracts/derive-variables.fixture.json` (the Python
 * mirror reads the same file in wave B); this suite runs every case and pins the rules the fixture
 * cannot state on its own (purity, the namespace list).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROMPT_VARIABLE_NAMESPACE_ROOTS,
  deriveVariableDeclarations,
  type PromptVariableDeclaration,
} from '../derive-variable-declarations';

interface DeriveCase {
  name: string;
  content: string | Array<string | null>;
  existing: PromptVariableDeclaration[] | null;
  expected: { declarations: PromptVariableDeclaration[]; added: string[]; stale: string[] };
}

const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../tests/contracts/derive-variables.fixture.json'), 'utf-8')) as {
  namespaceRoots: string[];
  cases: DeriveCase[];
};

describe('derive-variables fixture', () => {
  it('is not vacuous and names every case once', () => {
    const names = fixture.cases.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
  });

  it('declares the same namespace roots as the contract', () => {
    expect([...PROMPT_VARIABLE_NAMESPACE_ROOTS]).toEqual(fixture.namespaceRoots);
  });

  it.each(fixture.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(deriveVariableDeclarations(entry.content, entry.existing)).toEqual(entry.expected);
  });
});

describe('deriveVariableDeclarations — purity', () => {
  it('never mutates the existing array or its entries', () => {
    const existing: PromptVariableDeclaration[] = [{ name: 'a', type: 'string', required: true }];
    const snapshot = JSON.stringify(existing);
    const result = deriveVariableDeclarations('{{b}}', existing);
    expect(JSON.stringify(existing)).toBe(snapshot);
    expect(result.declarations[0]).toEqual(existing[0]);
  });

  it('is idempotent: deriving again over its own output adds nothing', () => {
    const first = deriveVariableDeclarations('{{a}} {{b.c}}', []);
    const second = deriveVariableDeclarations('{{a}} {{b.c}}', first.declarations);
    expect(second).toEqual({ declarations: first.declarations, added: [], stale: [] });
  });
});
