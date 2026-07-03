/**
 * TASK-409 — unit coverage for the break-glass SDK-error helpers. The dialog
 * component itself is exercised end-to-end by `apps/admin/e2e/task-409-*.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import { breakGlassStatus, isBreakGlassRequired } from '../break-glass-dialog';

/** Shape of an SDK `AgenticError` as thrown by `AgenticClient` HTTP failures. */
function sdkError(status: number, message = 'boom'): Error {
  const err = new Error(message) as Error & { context?: Record<string, unknown> };
  err.context = { status, endpoint: '/api/v1/admin/rbac/policies/p-1', requestId: 'req_1' };
  return err;
}

describe('break-glass SDK error helpers (TASK-409)', () => {
  it('extracts the HTTP status from an AgenticError-shaped error', () => {
    expect(breakGlassStatus(sdkError(428))).toBe(428);
    expect(breakGlassStatus(sdkError(401))).toBe(401);
    expect(breakGlassStatus(sdkError(400))).toBe(400);
  });

  it('returns undefined for plain errors and non-error values', () => {
    expect(breakGlassStatus(new Error('plain'))).toBeUndefined();
    expect(breakGlassStatus(null)).toBeUndefined();
    expect(breakGlassStatus(undefined)).toBeUndefined();
    expect(breakGlassStatus('nope')).toBeUndefined();
    expect(breakGlassStatus({ context: { status: 'not-a-number' } })).toBeUndefined();
  });

  it('isBreakGlassRequired matches exactly the 428 contract', () => {
    expect(isBreakGlassRequired(sdkError(428))).toBe(true);
    expect(isBreakGlassRequired(sdkError(403))).toBe(false);
    expect(isBreakGlassRequired(sdkError(401))).toBe(false);
    expect(isBreakGlassRequired(new Error('no status'))).toBe(false);
  });
});
