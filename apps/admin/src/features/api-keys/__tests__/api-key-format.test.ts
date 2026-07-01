import { describe, expect, it } from 'vitest';
import { maskedKey, scopesSummary } from '../api-key-format';

describe('maskedKey (TASK-391 #23)', () => {
    it('masks the middle between prefix and checksum', () => {
        expect(maskedKey({ prefix: 'hope_sk_a5c5', keyChecksum: '3f9a' })).toBe('hope_sk_a5c5••••3f9a');
    });

    it('accepts the alternate `checksum` field name', () => {
        expect(maskedKey({ prefix: 'hope_wh_1234', checksum: 'abcd' })).toBe('hope_wh_1234••••abcd');
    });

    it('masks the tail when only the prefix is known', () => {
        expect(maskedKey({ prefix: 'hope_sa_9999' })).toBe('hope_sa_9999••••');
    });

    it('is em-dash safe when no prefix is present', () => {
        expect(maskedKey({})).toBe('—');
        expect(maskedKey(null)).toBe('—');
        expect(maskedKey({ prefix: '  ' })).toBe('—');
    });
});

describe('scopesSummary (TASK-391 #23)', () => {
    it('summarizes many scopes as "N scopes · <first>"', () => {
        expect(scopesSummary(['stt:*', 'consultation:session:write', 'webhook:event:write'])).toBe('3 scopes · stt:*');
    });

    it('uses the singular noun for exactly one scope', () => {
        expect(scopesSummary(['*'])).toBe('1 scope · *');
    });

    it('renders "No scopes" for empty / missing / all-blank lists', () => {
        expect(scopesSummary([])).toBe('No scopes');
        expect(scopesSummary(undefined)).toBe('No scopes');
        expect(scopesSummary(['', '   '])).toBe('No scopes');
    });

    it('ignores blank entries when counting + picking the first', () => {
        expect(scopesSummary(['', 'stt:transcription:read', 'stt:stream:write'])).toBe('2 scopes · stt:transcription:read');
    });
});
