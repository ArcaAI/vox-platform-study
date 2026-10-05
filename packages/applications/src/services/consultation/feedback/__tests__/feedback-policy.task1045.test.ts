import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateFeedbackRequest, FeedbackPolicyError, assertFeedbackShape, reasonsFor, targetKey, validateReasonList } from '../index';

const reasons = [
  { code: 'missing_information', label: 'Missing information' },
  { code: 'wrong_section', label: 'Wrong section', appliesTo: ['SECTION'] as const },
];
const limits = { reasons, commentMaxChars: 20, maxMedia: 2 };
const target = { kind: 'NOTE' as const, contextItemId: 'i-1' };
const fail = (fn: () => void): FeedbackPolicyError => {
  try {
    fn();
  } catch (e) {
    return e as FeedbackPolicyError;
  }
  throw new Error('did not throw');
};

describe('targetKey', () => {
  it('joins kind|item|ver|section|entity, empty for absent parts', () => {
    expect(targetKey({ kind: 'SECTION', contextItemId: 'i-1', versionNumber: 3, sectionKey: 'plan' })).toBe('SECTION|i-1|3|plan|');
    expect(targetKey({ kind: 'ENTITY', contextItemId: 'i-1', entityRef: 'e-9' })).toBe('ENTITY|i-1|||e-9');
    expect(targetKey(target)).toBe('NOTE|i-1|||');
  });
});

describe('reasons', () => {
  it('filters by appliesTo', () => {
    expect(reasonsFor(reasons, 'NOTE').map((r) => r.code)).toEqual(['missing_information']);
    expect(reasonsFor(reasons, 'SECTION').map((r) => r.code)).toEqual(['missing_information', 'wrong_section']);
  });
  it('validates a configured list', () => {
    expect(validateReasonList(reasons)).toBeUndefined();
    expect(validateReasonList([])).toBeDefined();
    expect(validateReasonList([{ code: 'Bad', label: 'x' }])).toBeDefined();
    expect(validateReasonList([reasons[0], reasons[0]])).toBeDefined();
    expect(validateReasonList([{ code: 'ok_code', label: '' }])).toBeDefined();
    expect(validateReasonList(Array.from({ length: 33 }, (_, i) => ({ code: `code_${i}`, label: 'l' })))).toBeDefined();
  });
});

describe('assertFeedbackShape', () => {
  it('requires something', () => {
    expect(fail(() => assertFeedbackShape({ comment: '  ' }, limits)).code).toBe('FEEDBACK_EMPTY');
  });
  it('a rating needs a target; comment-only does not', () => {
    expect(fail(() => assertFeedbackShape({ rating: 'up' }, limits)).code).toBe('FEEDBACK_TARGET_REQUIRED');
    expect(() => assertFeedbackShape({ comment: 'fine' }, limits)).not.toThrow();
    expect(() => assertFeedbackShape({ rating: 'cleared', target }, limits)).not.toThrow();
  });
  it('a correction is only for NOTE/SECTION/SEGMENT/TRANSCRIPT', () => {
    expect(() => assertFeedbackShape({ target, correction: { content: 'x' } }, limits)).not.toThrow();
    const e = fail(() => assertFeedbackShape({ target: { kind: 'ENTITY', contextItemId: 'i' }, correction: { content: 'x' } }, limits));
    expect(e.code).toBe('FEEDBACK_CORRECTION_UNSUPPORTED');
    expect(fail(() => assertFeedbackShape({ correction: { content: 'x' } }, limits)).code).toBe('FEEDBACK_TARGET_REQUIRED');
  });
  it('reasons only with down, and from the effective list', () => {
    expect(fail(() => assertFeedbackShape({ rating: 'up', target, reasonCodes: ['missing_information'] }, limits)).code).toBe('FEEDBACK_REASON_NOT_ALLOWED');
    const unknown = fail(() => assertFeedbackShape({ rating: 'down', target, reasonCodes: ['nope'] }, limits));
    expect([unknown.code, unknown.httpStatus, unknown.details.allowed]).toEqual(['FEEDBACK_REASON_UNKNOWN', 400, ['missing_information']]);
    expect(() => assertFeedbackShape({ rating: 'down', target, reasonCodes: ['missing_information'] }, limits)).not.toThrow();
    expect(fail(() => assertFeedbackShape({ rating: 'down', target, reasonCodes: ['wrong_section'] }, limits)).code).toBe('FEEDBACK_REASON_UNKNOWN');
  });
  it('bounds comment length (413) and media', () => {
    const long = fail(() => assertFeedbackShape({ comment: 'x'.repeat(21) }, limits));
    expect([long.code, long.httpStatus]).toEqual(['FEEDBACK_COMMENT_TOO_LONG', 413]);
    expect(fail(() => assertFeedbackShape({ attachmentIds: ['a', 'b', 'c'] }, limits)).code).toBe('FEEDBACK_ATTACHMENT_INVALID');
    expect(fail(() => assertFeedbackShape({ attachmentIds: ['a', 'a'] }, limits)).code).toBe('FEEDBACK_ATTACHMENT_INVALID');
    expect(() => assertFeedbackShape({ attachmentIds: ['a', 'b'] }, limits)).not.toThrow();
  });
});

describe('CreateFeedbackRequest', () => {
  const check = (plain: object) =>
    validate(plainToInstance(CreateFeedbackRequest, plain), { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
  it('accepts a full body', async () => {
    expect(
      await check({
        target: { kind: 'SECTION', contextItemId: 'i', versionNumber: 2, sectionKey: 'plan' },
        rating: 'down',
        reasonCodes: ['missing_information'],
        comment: 'c',
        attachmentIds: ['a'],
        correction: { content: 'x', expectedVersion: 2 },
        client: { app: 'console' },
      }),
    ).toEqual([]);
  });
  it('rejects bad rating, bad target kind, unknown and nested-unknown fields', async () => {
    const errors = await check({ rating: 'meh', target: { kind: 'WHOLE', contextItemId: 'i', rogue: 1 }, extra: true });
    expect(errors.map((e) => e.property).sort()).toEqual(['extra', 'rating', 'target']);
  });
});
