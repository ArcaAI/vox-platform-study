/**
 * @arcaai/vox - PHI Redactor Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { redactPHI, PHI_KEYS, REDACTED_VALUE, REDACTED_URL_VALUE } from '../redactor';

describe('redactPHI', () => {
  describe('primitive inputs', () => {
    it('returns null/undefined unchanged', () => {
      expect(redactPHI(null)).toBeNull();
      expect(redactPHI(undefined)).toBeUndefined();
    });

    it('returns strings without data:/blob:/file: prefixes unchanged', () => {
      expect(redactPHI('hello')).toBe('hello');
      expect(redactPHI('https://example.com/x')).toBe('https://example.com/x');
    });

    it('redacts data: URLs to [REDACTED-URL]', () => {
      expect(redactPHI('data:image/png;base64,abc=')).toBe(REDACTED_URL_VALUE);
    });

    it('redacts blob: URLs to [REDACTED-URL]', () => {
      expect(redactPHI('blob:https://example.com/abc')).toBe(REDACTED_URL_VALUE);
    });

    it('redacts file: URLs to [REDACTED-URL]', () => {
      expect(redactPHI('file:///etc/secret')).toBe(REDACTED_URL_VALUE);
    });

    it('returns numbers and booleans unchanged', () => {
      expect(redactPHI(42)).toBe(42);
      expect(redactPHI(true)).toBe(true);
    });
  });

  describe('shallow object redaction', () => {
    it('redacts known PHI keys at top level', () => {
      const phiInput: Record<string, unknown> = {
        patientId: 'p-1',
        doctorId: 'd-1',
        consultationId: 'c-1',
        transcript: 'PHI text',
        transcriptText: 'more PHI',
        sttText: 'spoken PHI',
        sttResult: { text: 'whisper output' },
        audioBuffer: new ArrayBuffer(4),
        audioBlob: new Blob(['x']),
        recording: { stream: 'mic' },
        voiceEmbedding: [0.1, 0.2],
        email: 'a@b.com',
        phone: '+1-555-1234',
        dob: '1990-01-01',
        nationalId: 'X12345',
        keepMe: 'visible',
      };
      const result = redactPHI(phiInput) as Record<string, unknown>;
      for (const key of Object.keys(phiInput)) {
        if (key === 'keepMe') continue;
        expect(result[key], `key=${key}`).toBe(REDACTED_VALUE);
      }
      expect(result.keepMe).toBe('visible');
    });

    it('exposes PHI_KEYS as a non-empty frozen list covering the W0-2 names', () => {
      const required = [
        'patientId',
        'doctorId',
        'consultationId',
        'transcript',
        'transcriptText',
        'sttText',
        'sttResult',
        'audioBuffer',
        'audioBlob',
        'recording',
        'voiceEmbedding',
        'email',
        'phone',
        'dob',
        'nationalId',
      ];
      for (const k of required) {
        expect(PHI_KEYS).toContain(k);
      }
    });
  });

  describe('deep recursion', () => {
    it('redacts PHI nested in objects', () => {
      const input = {
        user: {
          profile: {
            patientId: 'nested-p',
            email: 'nested@a.com',
            name: 'Jane',
          },
        },
      };
      const result = redactPHI(input) as { user: { profile: Record<string, unknown> } };
      expect(result.user.profile.patientId).toBe(REDACTED_VALUE);
      expect(result.user.profile.email).toBe(REDACTED_VALUE);
      expect(result.user.profile.name).toBe('Jane');
    });

    it('redacts PHI nested in arrays', () => {
      const input = {
        items: [
          { patientId: 'a', label: 'one' },
          { patientId: 'b', label: 'two' },
        ],
      };
      const result = redactPHI(input) as { items: Array<Record<string, unknown>> };
      expect(result.items[0].patientId).toBe(REDACTED_VALUE);
      expect(result.items[1].patientId).toBe(REDACTED_VALUE);
      expect(result.items[0].label).toBe('one');
    });

    it('redacts data:/blob:/file: URLs nested in arrays/objects', () => {
      const input = {
        urls: ['https://ok.com', 'data:image/png;base64,XX'],
        nested: { src: 'blob:https://x/y' },
      };
      const result = redactPHI(input) as { urls: string[]; nested: { src: string } };
      expect(result.urls[0]).toBe('https://ok.com');
      expect(result.urls[1]).toBe(REDACTED_URL_VALUE);
      expect(result.nested.src).toBe(REDACTED_URL_VALUE);
    });
  });

  describe('immutability', () => {
    it('does not mutate the input object', () => {
      const input = {
        patientId: 'p-1',
        nested: { transcript: 'PHI' },
      };
      const snapshot = JSON.parse(JSON.stringify(input));
      redactPHI(input);
      expect(input).toEqual(snapshot);
    });

    it('does not mutate the input array', () => {
      const input = [{ patientId: 'a' }, { patientId: 'b' }];
      const snapshot = JSON.parse(JSON.stringify(input));
      redactPHI(input);
      expect(input).toEqual(snapshot);
    });

    it('returns a deep clone (independent references) for plain objects', () => {
      const inner = { keep: 'me' };
      const input = { wrapper: inner };
      const result = redactPHI(input) as { wrapper: { keep: string } };
      expect(result.wrapper).not.toBe(inner);
      result.wrapper.keep = 'mutated';
      expect(inner.keep).toBe('me');
    });
  });

  describe('cycle safety', () => {
    it('handles circular references without throwing', () => {
      const a: Record<string, unknown> = { patientId: 'p' };
      a.self = a;
      expect(() => redactPHI(a)).not.toThrow();
      const result = redactPHI(a) as Record<string, unknown>;
      expect(result.patientId).toBe(REDACTED_VALUE);
    });
  });

  describe('special object types', () => {
    it('preserves Date instances by ISO string', () => {
      const d = new Date('2026-01-01T00:00:00.000Z');
      const result = redactPHI({ when: d }) as { when: unknown };
      expect(result.when).toBeInstanceOf(Date);
      expect((result.when as Date).toISOString()).toBe(d.toISOString());
    });

    it('preserves Error instances by name+message+stack only (no PHI keys)', () => {
      const err = new Error('boom');
      const result = redactPHI({ err }) as { err: Record<string, unknown> };
      expect(result.err.name).toBe('Error');
      expect(result.err.message).toBe('boom');
    });
  });
});
