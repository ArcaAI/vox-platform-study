/**
 * Cross-language checksum parity guard (TASK-734 Task 4) — closes the gap TASK-718's README
 * named explicitly: `compiled_config.py`'s `canonical_json` port was "not verified byte-for-
 * byte against a live Node.js execution of the TypeScript original". This test IS that
 * verification's TS half: it regenerates `canonical`/`checksum` for every fixture case with
 * the real `canonicalJson()` and asserts the committed fixture still matches (so a change to
 * `canonicalJson` that silently alters its output breaks this test, not just a downstream
 * consumer). `test_compiled_config.py::TestCanonicalJsonParityFixture` is the Python half — it
 * asserts `compiled_config.canonical_json()` reproduces the SAME `canonical`/`checksum` from
 * the same fixture file, which is the actual byte-for-byte proof TASK-718 could not run.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonical-json';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../docs/implementation/TASK-734-Workflow-Substrate-Second-Pass/contracts/canonical-json-fixtures.json',
);

interface FixtureCase {
  name: string;
  value: unknown;
  canonical: string;
  checksum: string;
}

function loadFixtureCases(): FixtureCase[] {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { cases: FixtureCase[] };
  return raw.cases;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('canonicalJson <-> canonical_json.py parity fixture', () => {
  const cases = loadFixtureCases();

  it('the fixture is non-trivial (guards against an accidentally-empty fixture passing vacuously)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s: canonicalJson(value) matches the committed canonical string', (_name, testCase) => {
    expect(canonicalJson(testCase.value)).toBe(testCase.canonical);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s: sha256(canonical) matches the committed checksum', (_name, testCase) => {
    expect(sha256Hex(testCase.canonical)).toBe(testCase.checksum);
  });
});
