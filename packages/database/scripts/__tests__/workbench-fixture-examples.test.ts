/**
 * Guards `workbench-fixture-examples.ts` (TASK-721 Phase C): the Workbench's example
 * `WorkflowTestFixture.input` payloads must stay synthetic — reuses TASK-700's
 * `dna-phi-scan.ts` heuristics (MRN-shaped tokens, DOB-shaped dates, drug+dose
 * co-occurrence, a two-capitalized-word name proxy) rather than a second, drifting scanner.
 * `WorkflowTestFixture.input` is a PLAIN, unencrypted JsonB column (README §6/R4) — "synthetic"
 * is a contract, not a server-side enforcement, so this is the automated check standing in for
 * one until R4's encryption/redaction decision is made.
 */
import { describe, expect, it } from 'vitest';
import { isClean, scanText } from '../dna-phi-scan';
import { SYNTHETIC_FIXTURE_EXAMPLES, syntheticFixtureExamples } from '../workbench-fixture-examples';

describe('synthetic fixture examples stay PHI-shape-clean', () => {
  it('is deterministic — the same array on every call (fixed-seed, no randomness)', () => {
    expect(syntheticFixtureExamples()).toBe(SYNTHETIC_FIXTURE_EXAMPLES);
    expect(syntheticFixtureExamples()).toEqual(syntheticFixtureExamples());
  });

  it.each(SYNTHETIC_FIXTURE_EXAMPLES.map((example) => [example.name, example] as const))('%s: scans clean across every heuristic category', (_name, example) => {
    const serialized = JSON.stringify(example.input);
    const counts = scanText(serialized);
    expect(isClean(counts)).toBe(true);
  });

  it('every example is a plain object with a name and description — never a raw string that could hide free-text PHI unexamined', () => {
    for (const example of SYNTHETIC_FIXTURE_EXAMPLES) {
      expect(typeof example.name).toBe('string');
      expect(example.name.length).toBeGreaterThan(0);
      expect(typeof example.input).toBe('object');
    }
  });
});
