import { describe, expect, it } from 'vitest';
import type { GlobalSetting } from '@arcaai/vox';
import { groupByNamespace, isSettingLocked, namespaceLabel } from '../global-settings';

const setting = (key: string, namespace?: string, extra: Partial<GlobalSetting> = {}): GlobalSetting =>
    ({ id: key, key, value: null, namespace, ...extra }) as GlobalSetting;

describe('isSettingLocked (TASK-391 #24)', () => {
    it('is true only when the server flags locked === true', () => {
        expect(isSettingLocked({ locked: true })).toBe(true);
        expect(isSettingLocked({ locked: false })).toBe(false);
        expect(isSettingLocked({})).toBe(false);
        expect(isSettingLocked(null)).toBe(false);
        expect(isSettingLocked(undefined)).toBe(false);
    });

    it('does not treat truthy-but-not-true values as locked', () => {
        expect(isSettingLocked({ locked: 'yes' as unknown as boolean })).toBe(false);
        expect(isSettingLocked({ locked: 1 as unknown as boolean })).toBe(false);
    });
});

describe('namespaceLabel (TASK-391 #24)', () => {
    it('maps known namespaces to pretty labels', () => {
        expect(namespaceLabel('feature-flags')).toBe('Feature flags');
        expect(namespaceLabel('stt')).toBe('STT');
        expect(namespaceLabel('ux-constants')).toBe('UX constants');
    });

    it('renders unknown namespaces verbatim and empty as "Other"', () => {
        expect(namespaceLabel('custom-ns')).toBe('custom-ns');
        expect(namespaceLabel('')).toBe('Other');
        expect(namespaceLabel(undefined)).toBe('Other');
    });
});

describe('groupByNamespace (TASK-391 #24)', () => {
    it('orders groups by the canonical section order', () => {
        const groups = groupByNamespace([setting('a', 'admin'), setting('b', 'general'), setting('c', 'smr')]);
        expect(groups.map((g) => g.key)).toEqual(['general', 'smr', 'admin']);
    });

    it('places unknown namespaces after known ones and ungrouped last', () => {
        const groups = groupByNamespace([setting('x'), setting('y', 'zeta-custom'), setting('z', 'general')]);
        expect(groups.map((g) => g.key)).toEqual(['general', 'zeta-custom', '']);
        expect(groups.at(-1)?.label).toBe('Other');
    });

    it('buckets settings under their namespace, preserving input order within a group', () => {
        const groups = groupByNamespace([setting('flag-a', 'feature-flags'), setting('flag-b', 'feature-flags')]);
        expect(groups).toHaveLength(1);
        expect(groups[0].settings.map((s) => s.key)).toEqual(['flag-a', 'flag-b']);
        expect(groups[0].label).toBe('Feature flags');
    });
});
