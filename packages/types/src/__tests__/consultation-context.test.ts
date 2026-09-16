import { describe, expect, it } from 'vitest';
import { OPEN_REFUSAL_CODES, type OpenRefusalCode, type GoverningRunSummary } from '../consultation-context.js';

describe('OPEN_REFUSAL_CODES', () => {
  it('is a fixed, deduplicated list of every open() refusal code', () => {
    expect(new Set(OPEN_REFUSAL_CODES).size).toBe(OPEN_REFUSAL_CODES.length);
    expect(OPEN_REFUSAL_CODES).toEqual([
      'CONTEXT_SCHEMA_VIOLATION',
      'DEPARTMENT_UNKNOWN',
      'DEPARTMENT_AMBIGUOUS',
      'DEPARTMENT_MISMATCH',
      'VISIT_TYPE_INVALID',
      'CLINICIAN_REQUIRED',
      'CLINICIAN_MISMATCH',
      'CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER',
      'USER_IDENTITY_UNKNOWN',
      'USER_IDENTITY_AMBIGUOUS',
      'USER_IDENTITY_INVALID',
      'USER_IDENTITY_NOT_USABLE',
      'USER_IDENTITY_DEPARTMENT_UNRESOLVED',
      'WORKFLOW_CONTEXT_INCOMPATIBLE',
    ]);
  });

  it('includes the new WORKFLOW_CONTEXT_INCOMPATIBLE code the pre-dispatch check answers (lane B2)', () => {
    expect(OPEN_REFUSAL_CODES).toContain('WORKFLOW_CONTEXT_INCOMPATIBLE');
  });

  it('every member is assignable to OpenRefusalCode (compile-time check exercised at runtime)', () => {
    for (const code of OPEN_REFUSAL_CODES) {
      const typed: OpenRefusalCode = code;
      expect(typeof typed).toBe('string');
    }
  });
});

describe('GoverningRunSummary', () => {
  it('accepts the persisted-vocabulary status union and a null failureReason', () => {
    const summary: GoverningRunSummary = {
      workflowDefinitionSlug: 'gen-new-visit',
      workflowRunId: 'run-1',
      status: 'COMPLETED',
      degraded: false,
      decidedAt: '2026-09-17T00:00:00.000Z',
      failureReason: null,
    };
    expect(summary.status).toBe('COMPLETED');
    expect(summary.failureReason).toBeNull();
  });

  it('the persisted-vocabulary status union excludes the interpreter-only SUCCEEDED/DEGRADED words', () => {
    const persistedStatuses: ReadonlyArray<GoverningRunSummary['status']> = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT'];
    expect(persistedStatuses).not.toContain('SUCCEEDED');
    expect(persistedStatuses).not.toContain('DEGRADED');
  });
});
