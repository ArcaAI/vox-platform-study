/**
 * Pins the ten attachment / feedback settings: exact keys, scope, defaults, bounds, and the
 * reason-code list grammar (the one place a tenant can supply structured data).
 */
import { describe, expect, it } from 'vitest';
import {
  CONSULTATION_ATTACHMENTS_FEEDBACK_SETTINGS,
  FEEDBACK_REASON_CODES_DEFAULT,
} from '../descriptors/consultation-attachments-feedback.descriptors';

const byKey = (k: string) => {
  const d = CONSULTATION_ATTACHMENTS_FEEDBACK_SETTINGS.find((s) => s.key === k);
  if (!d) throw new Error(`missing ${k}`);
  return d;
};
const ok = (k: string, v: unknown) => expect(byKey(k).validate?.(v)).toBeUndefined();
const bad = (k: string, v: unknown) => expect(typeof byKey(k).validate?.(v)).toBe('string');

const EXPECTED: Array<[string, 'tenant' | 'system', unknown]> = [
  ['consultation.attachments.multipartMaxMb', 'tenant', 10],
  ['consultation.attachments.uploadUrlTtlSeconds', 'system', 600],
  ['consultation.attachments.intentTtlHours', 'system', 24],
  ['consultation.attachments.reapCron', 'system', '*/15 * * * *'],
  ['consultation.attachments.inlineVerifyMaxMb', 'system', 32],
  ['consultation.feedback.commentMaxChars', 'system', 4000],
  ['consultation.feedback.maxMediaPerFeedback', 'system', 3],
  ['consultation.feedback.rollupCron', 'system', '30 1 * * *'],
  ['consultation.feedback.rollupLookbackDays', 'system', 2],
];

describe('TASK-1045 attachment/feedback descriptors', () => {
  it('registers ten unique keys', () => {
    const keys = CONSULTATION_ATTACHMENTS_FEEDBACK_SETTINGS.map((d) => d.key);
    expect(keys).toHaveLength(10);
    expect(new Set(keys).size).toBe(10);
  });

  it.each(EXPECTED)('%s: scope %s, default %j, global-kv open-to-default', (key, scope, def) => {
    const d = byKey(key);
    expect(d.maxScope).toBe(scope);
    expect(d.default).toEqual(def);
    expect(d.tier).toBe('global-kv');
    expect(d.failMode).toBe('open-to-default');
    expect(d.label && d.description).toBeTruthy();
    expect(d.killSwitch).toBeUndefined();
    // Every default satisfies its own validator.
    expect(d.validate?.(d.default)).toBeUndefined();
  });

  it('system-scope keys are platform-admin only; tenant-scope keys are not', () => {
    for (const [key, scope] of EXPECTED) expect(byKey(key).globalOnly === true).toBe(scope === 'system');
  });

  it('uploadUrlTtlSeconds is bounded 60–3600', () => {
    const k = 'consultation.attachments.uploadUrlTtlSeconds';
    ok(k, 60);
    ok(k, 3600);
    bad(k, 59);
    bad(k, 3601);
    bad(k, 600.5);
    bad(k, '600');
  });

  it('numeric keys reject zero, negatives and non-integers', () => {
    for (const k of [
      'consultation.attachments.multipartMaxMb',
      'consultation.attachments.intentTtlHours',
      'consultation.attachments.inlineVerifyMaxMb',
      'consultation.feedback.commentMaxChars',
      'consultation.feedback.rollupLookbackDays',
    ]) {
      bad(k, 0);
      bad(k, -1);
      bad(k, 1.5);
      bad(k, NaN);
    }
    ok('consultation.feedback.maxMediaPerFeedback', 0);
    bad('consultation.feedback.maxMediaPerFeedback', -1);
  });

  it('cron keys need five fields', () => {
    for (const k of ['consultation.attachments.reapCron', 'consultation.feedback.rollupCron']) {
      ok(k, '0 3 * * *');
      bad(k, '* * * *');
      bad(k, '');
      bad(k, 5);
    }
  });

  describe('reasonCodes', () => {
    const K = 'consultation.feedback.reasonCodes';
    it('is a tenant-scope json list defaulting to the seven system codes with human labels', () => {
      const d = byKey(K);
      expect(d.dataType).toBe('json');
      expect(d.maxScope).toBe('tenant');
      expect((d.default as { code: string }[]).map((r) => r.code)).toEqual([
        'missing_information',
        'wrong_medication_or_dose',
        'wrong_patient_detail',
        'made_something_up',
        'wrong_section',
        'too_long',
        'wrong_language',
      ]);
      expect(FEEDBACK_REASON_CODES_DEFAULT.every((r) => r.label.length >= 1 && r.label !== r.code)).toBe(true);
    });
    it('accepts valid lists, with and without appliesTo', () => {
      ok(K, [{ code: 'ab', label: 'x' }]);
      ok(K, [{ code: 'a_1', label: 'x'.repeat(80), appliesTo: ['note_section'] }]);
      ok(K, Array.from({ length: 32 }, (_, i) => ({ code: `code_${i}`, label: 'L' })));
    });
    it('rejects bad lists', () => {
      bad(K, 'nope');
      bad(K, []);
      bad(K, Array.from({ length: 33 }, (_, i) => ({ code: `code_${i}`, label: 'L' })));
      bad(K, [{ code: 'A', label: 'x' }]);
      bad(K, [{ code: 'a', label: 'x' }]); // too short (min 2 chars)
      bad(K, [{ code: '1ab', label: 'x' }]);
      bad(K, [{ code: 'Ab_c', label: 'x' }]);
      bad(K, [{ code: 'a' + 'b'.repeat(48), label: 'x' }]); // 49 chars
      bad(K, [{ code: 'abc', label: '' }]);
      bad(K, [{ code: 'abc', label: 'x'.repeat(81) }]);
      bad(K, [{ code: 'abc', label: 'x' }, { code: 'abc', label: 'y' }]);
      bad(K, [{ code: 'abc' }]);
      bad(K, [null]);
      bad(K, [{ code: 'abc', label: 'x', appliesTo: 'note' }]);
    });
    it('accepts a 48-char code', () => ok(K, [{ code: 'a' + 'b'.repeat(47), label: 'x' }]));
  });
});
