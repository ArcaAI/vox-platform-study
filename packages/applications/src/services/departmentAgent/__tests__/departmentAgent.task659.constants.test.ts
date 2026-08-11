/**
 * TASK-659 — pure structural validators for the agent loop-configuration
 * surface (subscribedKinds, writeScope, goal, guardrailProfile,
 * alwaysActions/neverActions). Mirrors the existing constants.ts test style
 * (`departmentAgent.service.test.ts` covers the service wrapper; this file
 * covers the never-throwing `*Problems()` functions directly).
 */
import { describe, it, expect } from 'vitest';
import {
  AGENT_ACTION_KEYS,
  GUARDRAIL_PROFILE_KEYS,
  actionListProblems,
  actionOverlapProblems,
  goalProblems,
  guardrailProfileProblems,
  subscribedKindsProblems,
  writeScopeProblems,
} from '../constants';

describe('subscribedKindsProblems', () => {
  it('accepts a well-formed payload and returns the declared kind keys', () => {
    const { problems, kindKeys } = subscribedKindsProblems({ version: 1, kinds: [{ key: 'referral_letter' }, { key: 'triage_form' }] });
    expect(problems).toEqual([]);
    expect(kindKeys).toEqual(['referral_letter', 'triage_form']);
  });

  it('accepts a per-kind filter object', () => {
    const { problems } = subscribedKindsProblems({ version: 1, kinds: [{ key: 'referral_letter', filter: { severity: 'high' } }] });
    expect(problems).toEqual([]);
  });

  it('rejects a version other than 1', () => {
    const { problems } = subscribedKindsProblems({ version: 2, kinds: [{ key: 'x' }] });
    expect(problems.some((p) => p.includes('version must be 1'))).toBe(true);
  });

  it('rejects an unknown top-level key', () => {
    const { problems } = subscribedKindsProblems({ version: 1, kinds: [], mode: 'strict' });
    expect(problems.some((p) => p.includes('unknown key'))).toBe(true);
  });

  it('rejects a malformed key grammar', () => {
    const { problems } = subscribedKindsProblems({ kinds: [{ key: 'Not Valid!' }] });
    expect(problems.length).toBeGreaterThan(0);
  });

  it('rejects a duplicate kind key', () => {
    const { problems } = subscribedKindsProblems({ kinds: [{ key: 'xx' }, { key: 'xx' }] });
    expect(problems.some((p) => p.includes('duplicate kind'))).toBe(true);
  });

  it('rejects an unknown per-kind-entry key', () => {
    const { problems } = subscribedKindsProblems({ kinds: [{ key: 'xx', extra: true }] });
    expect(problems.some((p) => p.includes('unknown key'))).toBe(true);
  });

  it('tolerates an absent kinds array (nothing subscribed)', () => {
    const { problems, kindKeys } = subscribedKindsProblems({ version: 1 });
    expect(problems).toEqual([]);
    expect(kindKeys).toEqual([]);
  });
});

describe('writeScopeProblems', () => {
  it('accepts a well-formed payload and returns the declared output keys', () => {
    const { problems, outputKeys } = writeScopeProblems({ version: 1, outputs: ['soap_note'] });
    expect(problems).toEqual([]);
    expect(outputKeys).toEqual(['soap_note']);
  });

  it('rejects a non-string output entry', () => {
    const { problems } = writeScopeProblems({ outputs: [123] });
    expect(problems.length).toBeGreaterThan(0);
  });

  it('rejects a duplicate output key', () => {
    const { problems } = writeScopeProblems({ outputs: ['soap_note', 'soap_note'] });
    expect(problems.some((p) => p.includes('duplicate output'))).toBe(true);
  });

  it('rejects an unknown top-level key', () => {
    const { problems } = writeScopeProblems({ outputs: [], strict: true });
    expect(problems.some((p) => p.includes('unknown key'))).toBe(true);
  });
});

describe('guardrailProfileProblems', () => {
  it.each(GUARDRAIL_PROFILE_KEYS)('accepts the catalogued profile %s', (profile) => {
    expect(guardrailProfileProblems(profile)).toEqual([]);
  });

  it('rejects an uncatalogued profile', () => {
    expect(guardrailProfileProblems('YOLO')).not.toEqual([]);
  });
});

describe('actionListProblems / actionOverlapProblems', () => {
  it.each(AGENT_ACTION_KEYS)('accepts the registered action %s', (action) => {
    expect(actionListProblems([action], 'alwaysActions')).toEqual([]);
  });

  it('rejects an unregistered action', () => {
    expect(actionListProblems(['not.a.real.action'], 'alwaysActions').length).toBeGreaterThan(0);
  });

  it('rejects a duplicate action', () => {
    expect(actionListProblems(['harness.finalize', 'harness.finalize'], 'neverActions').length).toBeGreaterThan(0);
  });

  it('rejects an action present in both always and never', () => {
    const problems = actionOverlapProblems(['harness.finalize'], ['harness.finalize', 'client.emit']);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('accepts disjoint always/never lists', () => {
    expect(actionOverlapProblems(['harness.finalize'], ['client.emit'])).toEqual([]);
  });

  it('tolerates either side being absent', () => {
    expect(actionOverlapProblems(undefined, ['client.emit'])).toEqual([]);
    expect(actionOverlapProblems(['harness.finalize'], null)).toEqual([]);
  });
});

describe('goalProblems', () => {
  it('accepts a bounded objective with no successCriteria', () => {
    expect(goalProblems({ version: 1, objective: 'Draft a concise SOAP note.' })).toEqual([]);
  });

  it('accepts bounded successCriteria', () => {
    expect(
      goalProblems({ version: 1, objective: 'Draft a concise SOAP note.', successCriteria: ['Cites every medication dose', 'No hallucinated findings'] }),
    ).toEqual([]);
  });

  it('rejects a missing objective', () => {
    expect(goalProblems({ version: 1 }).length).toBeGreaterThan(0);
  });

  it('rejects an objective over the length cap (not a free-text prompt)', () => {
    expect(goalProblems({ objective: 'x'.repeat(281) }).length).toBeGreaterThan(0);
  });

  it('rejects more than 10 successCriteria', () => {
    expect(goalProblems({ objective: 'ok', successCriteria: Array.from({ length: 11 }, (_, i) => `criterion ${i}`) }).length).toBeGreaterThan(
      0,
    );
  });

  it('rejects an unknown top-level key', () => {
    expect(goalProblems({ objective: 'ok', instructions: 'do whatever you want' }).length).toBeGreaterThan(0);
  });
});
