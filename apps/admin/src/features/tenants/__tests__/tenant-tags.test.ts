import { describe, expect, it } from 'vitest';
import { addTag, normalizeTag, normalizeTags, removeTag, tagsChanged } from '../tenant-tags';

describe('tenant-tags helpers', () => {
    describe('normalizeTag', () => {
        it('trims and collapses inner whitespace', () => {
            expect(normalizeTag('  pilot ')).toBe('pilot');
            expect(normalizeTag('high   priority')).toBe('high priority');
        });
    });

    describe('normalizeTags', () => {
        it('drops empties and de-duplicates preserving first-seen order', () => {
            expect(normalizeTags(['pilot', '  ', 'pilot', 'vip'])).toEqual(['pilot', 'vip']);
        });
    });

    describe('addTag', () => {
        it('appends a normalized tag', () => {
            expect(addTag(['pilot'], '  vip ')).toEqual(['pilot', 'vip']);
        });

        it('is a no-op for empty or duplicate tags (returns the same reference)', () => {
            const tags = ['pilot'];
            expect(addTag(tags, '   ')).toBe(tags);
            expect(addTag(tags, 'pilot')).toBe(tags);
        });
    });

    describe('removeTag', () => {
        it('removes by exact value', () => {
            expect(removeTag(['pilot', 'vip'], 'pilot')).toEqual(['vip']);
            expect(removeTag(['pilot'], 'missing')).toEqual(['pilot']);
        });
    });

    describe('tagsChanged', () => {
        it('is order-insensitive', () => {
            expect(tagsChanged(['a', 'b'], ['b', 'a'])).toBe(false);
            expect(tagsChanged(['a'], ['a', 'b'])).toBe(true);
            expect(tagsChanged(['a', 'b'], ['a', 'c'])).toBe(true);
        });
    });
});
