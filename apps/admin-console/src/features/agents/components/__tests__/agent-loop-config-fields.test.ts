/**
 * Pure-logic unit tests for the Loop config tab's TASK-659 field helpers
 * (TASK-667). These mirror the shape of the server-side validators in
 * `packages/applications/src/services/departmentAgent/constants.ts` without
 * importing them (features/console never imports a server package) — a
 * client-side mirror keeps the picker offering only values the server would
 * accept, but the server remains the authority.
 */

import { describe, expect, it } from 'vitest';
import {
  actionOverlap,
  AGENT_ACTION_KEYS,
  AGENT_BUDGET_FIELDS,
  buildBudgetsHarnessOverridesPayload,
  buildGoalPayload,
  buildSubscribedKindsPayload,
  buildToolConfigPayload,
  buildWriteScopePayload,
  C25_CONFIRM_PHRASE,
  GUARDRAIL_PROFILE_KEYS,
  goalObjectiveProblem,
  goalSuccessCriterionProblem,
  LIVE_TOOL_KEYS,
  parseGoal,
  parseSubscribedKinds,
  parseToolConfig,
  parseWriteScope,
  weakensClinicalCheck,
} from '../agent-loop-config-fields';

describe('agent-loop-config-fields', () => {
  it('exposes the exact seven action keys the server allow-lists (order-independent)', () => {
    expect([...AGENT_ACTION_KEYS].sort()).toEqual(
      [
        'livedoc.start',
        'livedoc.stop',
        'vision.extract_text',
        'document.extract_text',
        'nlp.extract_entities',
        'harness.finalize',
        'client.emit',
      ].sort(),
    );
  });

  it('exposes the exact guardrail profile catalogue', () => {
    expect(GUARDRAIL_PROFILE_KEYS).toEqual(['STANDARD', 'STRICT', 'RELAXED']);
  });

  it('exposes the exact tool-allowlist catalogue', () => {
    expect(LIVE_TOOL_KEYS).toEqual(['ner', 'vitals', 'groundedness']);
  });

  it('exposes the three budget harnessOverrides keys, locked-for-tenant-admin', () => {
    expect(AGENT_BUDGET_FIELDS.map((field) => field.key)).toEqual(['maxRegen', 'gateSlaSeconds', 'gateEscalationSeconds']);
  });

  describe('goalObjectiveProblem', () => {
    it('rejects an empty objective', () => {
      expect(goalObjectiveProblem('')).toMatch(/required/);
      expect(goalObjectiveProblem('   ')).toMatch(/required/);
    });

    it('rejects an objective over 280 characters', () => {
      expect(goalObjectiveProblem('a'.repeat(281))).toMatch(/280/);
    });

    it('accepts a short objective', () => {
      expect(goalObjectiveProblem('Summarize the visit into a SOAP note.')).toBeNull();
    });
  });

  describe('goalSuccessCriterionProblem', () => {
    it('rejects an empty criterion', () => {
      expect(goalSuccessCriterionProblem('')).toMatch(/empty/);
    });

    it('rejects a criterion over 200 characters', () => {
      expect(goalSuccessCriterionProblem('a'.repeat(201))).toMatch(/200/);
    });

    it('accepts a short criterion', () => {
      expect(goalSuccessCriterionProblem('Includes chief complaint')).toBeNull();
    });
  });

  describe('actionOverlap', () => {
    it('is empty when the two lists share nothing', () => {
      expect(actionOverlap(['livedoc.start'], ['harness.finalize'])).toEqual([]);
    });

    it('names every action present in both lists', () => {
      expect(actionOverlap(['livedoc.start', 'harness.finalize'], ['harness.finalize'])).toEqual(['harness.finalize']);
    });
  });

  describe('weakensClinicalCheck', () => {
    it('flags a transition INTO RELAXED', () => {
      const reasons = weakensClinicalCheck({
        currentGuardrailProfile: 'STANDARD',
        nextGuardrailProfile: 'RELAXED',
        currentNeverActions: null,
        nextNeverActions: null,
      });
      expect(reasons.some((reason) => /RELAXED/.test(reason))).toBe(true);
    });

    it('does not flag staying on RELAXED (no transition)', () => {
      const reasons = weakensClinicalCheck({
        currentGuardrailProfile: 'RELAXED',
        nextGuardrailProfile: 'RELAXED',
        currentNeverActions: null,
        nextNeverActions: null,
      });
      expect(reasons).toEqual([]);
    });

    it('does not flag STANDARD -> STRICT (tightening, not weakening)', () => {
      const reasons = weakensClinicalCheck({
        currentGuardrailProfile: 'STANDARD',
        nextGuardrailProfile: 'STRICT',
        currentNeverActions: null,
        nextNeverActions: null,
      });
      expect(reasons).toEqual([]);
    });

    it('flags newly forbidding a clinical-safety action (nlp.extract_entities) via neverActions', () => {
      const reasons = weakensClinicalCheck({
        currentGuardrailProfile: 'STANDARD',
        nextGuardrailProfile: 'STANDARD',
        currentNeverActions: [],
        nextNeverActions: ['nlp.extract_entities'],
      });
      expect(reasons.some((reason) => /nlp\.extract_entities/.test(reason))).toBe(true);
    });

    it('flags newly forbidding harness.finalize via neverActions', () => {
      const reasons = weakensClinicalCheck({
        currentGuardrailProfile: 'STANDARD',
        nextGuardrailProfile: 'STANDARD',
        currentNeverActions: null,
        nextNeverActions: ['harness.finalize'],
      });
      expect(reasons.some((reason) => /harness\.finalize/.test(reason))).toBe(true);
    });

    it('does not flag a non-clinical action added to neverActions', () => {
      const reasons = weakensClinicalCheck({
        currentGuardrailProfile: 'STANDARD',
        nextGuardrailProfile: 'STANDARD',
        currentNeverActions: [],
        nextNeverActions: ['client.emit'],
      });
      expect(reasons).toEqual([]);
    });

    it('does not flag a clinical action already forbidden before this edit', () => {
      const reasons = weakensClinicalCheck({
        currentGuardrailProfile: 'STANDARD',
        nextGuardrailProfile: 'STANDARD',
        currentNeverActions: ['harness.finalize'],
        nextNeverActions: ['harness.finalize'],
      });
      expect(reasons).toEqual([]);
    });
  });

  describe('C25_CONFIRM_PHRASE', () => {
    it('is a non-empty, stable phrase', () => {
      expect(C25_CONFIRM_PHRASE.length).toBeGreaterThan(0);
    });
  });

  describe('payload builders', () => {
    it('buildSubscribedKindsPayload omits an absent filter and preserves a present one', () => {
      expect(buildSubscribedKindsPayload([{ key: 'referral_letter' }, { key: 'triage_form', filter: { severity: 'high' } }])).toEqual({
        version: 1,
        kinds: [{ key: 'referral_letter' }, { key: 'triage_form', filter: { severity: 'high' } }],
      });
    });

    it('buildSubscribedKindsPayload returns null for an empty selection', () => {
      expect(buildSubscribedKindsPayload([])).toBeNull();
    });

    it('buildWriteScopePayload wraps output keys, null for empty', () => {
      expect(buildWriteScopePayload(['soap_note'])).toEqual({ version: 1, outputs: ['soap_note'] });
      expect(buildWriteScopePayload([])).toBeNull();
    });

    it('buildGoalPayload requires a non-empty objective, else null', () => {
      expect(buildGoalPayload('', [])).toBeNull();
      expect(buildGoalPayload('Summarize the visit', [])).toEqual({ version: 1, objective: 'Summarize the visit' });
      expect(buildGoalPayload('Summarize the visit', ['Includes chief complaint'])).toEqual({
        version: 1,
        objective: 'Summarize the visit',
        successCriteria: ['Includes chief complaint'],
      });
    });

    it('buildToolConfigPayload sets every tool explicitly (allow/deny, never omitted)', () => {
      expect(buildToolConfigPayload(['ner'])).toEqual({
        version: 1,
        tools: { ner: { enabled: true }, vitals: { enabled: false }, groundedness: { enabled: false } },
      });
      expect(buildToolConfigPayload([])).toEqual({
        version: 1,
        tools: { ner: { enabled: false }, vitals: { enabled: false }, groundedness: { enabled: false } },
      });
    });

    it('buildBudgetsHarnessOverridesPayload merges budget edits without dropping other existing keys', () => {
      expect(buildBudgetsHarnessOverridesPayload({ toolAllowlist: ['ner'] }, { maxRegen: 3 })).toEqual({
        toolAllowlist: ['ner'],
        maxRegen: 3,
      });
    });

    it('buildBudgetsHarnessOverridesPayload works from an undefined base', () => {
      expect(buildBudgetsHarnessOverridesPayload(undefined, { gateSlaSeconds: 60 })).toEqual({ gateSlaSeconds: 60 });
    });
  });

  describe('hydration parsers', () => {
    it('parseSubscribedKinds round-trips a well-formed payload and degrades a malformed one', () => {
      expect(parseSubscribedKinds({ version: 1, kinds: [{ key: 'referral_letter' }, { key: 'triage_form', filter: { severity: 'high' } }] })).toEqual([
        { key: 'referral_letter' },
        { key: 'triage_form', filter: { severity: 'high' } },
      ]);
      expect(parseSubscribedKinds(null)).toEqual([]);
      expect(parseSubscribedKinds({ kinds: 'not-an-array' })).toEqual([]);
    });

    it('parseWriteScope round-trips outputs and degrades a malformed one', () => {
      expect(parseWriteScope({ version: 1, outputs: ['soap_note'] })).toEqual(['soap_note']);
      expect(parseWriteScope(undefined)).toEqual([]);
    });

    it('parseGoal round-trips objective + successCriteria and degrades to empty', () => {
      expect(parseGoal({ version: 1, objective: 'Summarize', successCriteria: ['a', 'b'] })).toEqual({
        objective: 'Summarize',
        successCriteria: ['a', 'b'],
      });
      expect(parseGoal(null)).toEqual({ objective: '', successCriteria: [] });
    });

    it('parseToolConfig returns only the tools explicitly enabled', () => {
      expect(parseToolConfig({ version: 1, tools: { ner: { enabled: true }, vitals: { enabled: false } } })).toEqual(['ner']);
      expect(parseToolConfig(null)).toEqual([]);
    });
  });
});
