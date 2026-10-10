import { describe, expect, it } from 'vitest';
import { ContextJudgeUnavailableError } from '../IContextMedicalJudgeService';

describe('ContextJudgeUnavailableError (TASK-1059 C-0)', () => {
  it('carries the GUARDRAIL_UNAVAILABLE code and the cause', () => {
    const cause = new Error('ECONNREFUSED');
    const error = new ContextJudgeUnavailableError('down', { cause });
    expect(error.code).toBe('GUARDRAIL_UNAVAILABLE');
    expect(error.name).toBe('ContextJudgeUnavailableError');
    expect(error.message).toBe('down');
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });
});
