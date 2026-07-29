/**
 * Pure category mapping for the tenant Settings tab:
 * deterministic key/namespace → category, unknown-key fallback, and the
 * dataType → control mapping.
 */

import { describe, expect, it } from 'vitest';
import { CONFIG_CATEGORIES, categorize, controlFor, groupByCategory } from '../config-categories';

describe('categorize', () => {
  it('buckets by namespace/key keyword conventions', () => {
    expect(categorize({ key: 'session-timeout-minutes', namespace: 'security' })).toBe('security');
    expect(categorize({ key: 'data-region', namespace: 'platform' })).toBe('data-residency');
    expect(categorize({ key: 'retention-days', namespace: null })).toBe('data-residency');
    expect(categorize({ key: 'notify-on-summary', namespace: 'notifications' })).toBe('notifications');
    expect(categorize({ key: 'default-asr-model', namespace: 'stt.config' })).toBe('clinical');
    expect(categorize({ key: 'enable-diarization', namespace: 'feature-flags' })).toBe('clinical');
  });

  it('falls back to general for unknown keys', () => {
    expect(categorize({ key: 'theme-accent', namespace: 'ui' })).toBe('general');
    expect(categorize({ key: 'misc-flag', namespace: null })).toBe('general');
  });

  it('is deterministic and case-insensitive', () => {
    const input = { key: 'SESSION-Timeout', namespace: 'Security' };
    expect(categorize(input)).toBe('security');
    expect(categorize(input)).toBe(categorize(input));
  });
});

describe('groupByCategory', () => {
  it('groups rows preserving input order and covers every category key', () => {
    const rows = [
      { key: 'a-misc', namespace: null },
      { key: 'session-timeout', namespace: 'security' },
      { key: 'b-misc', namespace: null },
    ];
    const groups = groupByCategory(rows);
    expect(groups.general.map((r) => r.key)).toEqual(['a-misc', 'b-misc']);
    expect(groups.security).toHaveLength(1);
    // Every declared category has an array (rail can render counts safely).
    for (const category of CONFIG_CATEGORIES) expect(Array.isArray(groups[category.id])).toBe(true);
  });
});

describe('controlFor', () => {
  it('maps dataType to the matching control (PascalCase ValueType and lowercase aliases)', () => {
    expect(controlFor('Boolean')).toBe('switch');
    expect(controlFor('boolean')).toBe('switch');
    expect(controlFor('Integer')).toBe('number');
    expect(controlFor('Float')).toBe('number');
    expect(controlFor('number')).toBe('number');
    expect(controlFor('Date')).toBe('date');
    expect(controlFor('DateTime')).toBe('date');
    expect(controlFor('Json')).toBe('textarea');
    expect(controlFor('Array')).toBe('textarea');
    expect(controlFor('String')).toBe('text');
    expect(controlFor(null)).toBe('text');
  });
});
