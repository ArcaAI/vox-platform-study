/**
 * `schemaVariablePaths` cross-language parity (TypeScript half).
 *
 * The console's completion list and the gateway publish gate read `schemaVariablePaths`
 * (`@arcaai/workflow-contract`); the harness reads `schema_variable_paths.py`. Both are held to
 * THIS fixture — the Python half is
 * `apps/harness/src/harness/tests/unit/temporal/interpreter/test_schema_variable_paths_parity.py`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CONTRACT_SRC = path.resolve(__dirname, '../../packages/workflow-contract/src/schema-variable-paths.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { schemaVariablePaths } = contract;

interface PathsCase {
  name: string;
  definition: unknown;
  root: string;
  expected: Array<{ path: string; type: string; required: boolean; phiClass: string | null; description: string | null; deprecated: boolean }>;
}

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'schema-variable-paths.fixture.json'), 'utf-8')) as { cases: PathsCase[] };

describe('schema-variable-paths fixture — not vacuous', () => {
  it('covers the sole-kind collapse, PHI classes, deprecation, an inline schema and the total cases', () => {
    const names = fixture.cases.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'sole-context-kind-collapses-under-context',
        'sole-context-kind-keeps-envelope-under-trigger',
        'inline-payload-schema',
      ]),
    );
    const all = fixture.cases.flatMap((entry) => entry.expected);
    expect(new Set(all.map((entry) => entry.phiClass))).toEqual(new Set(['PHI', 'NON_PHI', null]));
    expect(all.some((entry) => entry.deprecated)).toBe(true);
    expect(fixture.cases.some((entry) => entry.expected.length === 0)).toBe(true);
  });
});

describe('schemaVariablePaths over the shared fixture', () => {
  it.each(fixture.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(schemaVariablePaths(JSON.parse(JSON.stringify(entry.definition)), entry.root)).toEqual(entry.expected);
  });
});
