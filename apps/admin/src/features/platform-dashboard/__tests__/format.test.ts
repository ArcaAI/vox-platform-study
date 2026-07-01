import { describe, expect, it } from 'vitest';
import { formatCount } from '../format';

describe('formatCount', () => {
    it('groups thousands with the en-US locale', () => {
        expect(formatCount(1847)).toBe('1,847');
        expect(formatCount(14208)).toBe('14,208');
        expect(formatCount(27)).toBe('27');
    });

    it('renders 0 as "0" (not an em-dash)', () => {
        expect(formatCount(0)).toBe('0');
    });

    it('falls back to an em-dash for nullish / non-finite values', () => {
        expect(formatCount(undefined)).toBe('\u2014');
        expect(formatCount(null)).toBe('\u2014');
        expect(formatCount(Number.NaN)).toBe('\u2014');
        expect(formatCount(Number.POSITIVE_INFINITY)).toBe('\u2014');
    });
});
