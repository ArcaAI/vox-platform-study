import { describe, it, expect } from 'vitest';
import { MAX_IDEMPOTENCY_KEY_LENGTH, idempotencyKeyProblems, AsyncIdempotencyKey } from '../idempotency';

describe('idempotencyKeyProblems — grammar reused verbatim from usageLedger/idempotency-keys.ts', () => {
  it('accepts a well-formed key', () => {
    expect(idempotencyKeyProblems('stt:session:abc:seg:0')).toEqual([]);
  });

  it('rejects an empty string', () => {
    expect(idempotencyKeyProblems('')).toEqual(['idempotencyKey must be a non-empty string']);
  });

  it('rejects a key over the max length', () => {
    const problems = idempotencyKeyProblems('a'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1));
    expect(problems.join(' ')).toMatch(new RegExp(`at most ${MAX_IDEMPOTENCY_KEY_LENGTH}`));
  });

  it('rejects whitespace', () => {
    const problems = idempotencyKeyProblems('has a space');
    expect(problems.join(' ')).toMatch(/no whitespace or control characters/);
  });

  it('rejects a non-string value', () => {
    expect(idempotencyKeyProblems(undefined)).toEqual(['idempotencyKey must be a non-empty string']);
  });
});

describe('AsyncIdempotencyKey — intent-derived recipes (§3.5 recipe table)', () => {
  it('sttSegment: stt:session:<sessionId>:seg:<utteranceIndex>', () => {
    expect(AsyncIdempotencyKey.sttSegment('sess-1', 3)).toBe('stt:session:sess-1:seg:3');
  });

  it('textChunk: text:task:<taskId>:chunk:<sequence>', () => {
    expect(AsyncIdempotencyKey.textChunk('task-1', 7)).toBe('text:task:task-1:chunk:7');
  });

  it('workflowNode: wf:run:<runId>:node:<nodeId>:<attemptGeneration>', () => {
    expect(AsyncIdempotencyKey.workflowNode('run-1', 'node-1', 2)).toBe('wf:run:run-1:node:node-1:2');
  });

  it('webhookDelivery: hook:<subscriptionId>:<sourceEnvelopeId>', () => {
    expect(AsyncIdempotencyKey.webhookDelivery('sub-1', 'env-1')).toBe('hook:sub-1:env-1');
  });

  it('is a pure function — the same intent always yields the same key', () => {
    expect(AsyncIdempotencyKey.textChunk('task-1', 7)).toBe(AsyncIdempotencyKey.textChunk('task-1', 7));
  });

  it('throws on a blank intent id rather than silently collapsing every event onto one key', () => {
    expect(() => AsyncIdempotencyKey.textChunk('  ', 0)).toThrow(/taskId is required/);
  });
});
