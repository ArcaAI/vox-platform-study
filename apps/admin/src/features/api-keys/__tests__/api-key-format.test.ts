import { describe, expect, it } from 'vitest';
import { environmentLabel, ipAllowlistSummary, maskedKey, normalizeIpList, parseIpInput, rateLimitLabel, scopesSummary } from '../api-key-format';

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

describe('rateLimitLabel (TASK-395 P1-5)', () => {
  it('formats a numeric rate limit as "N/min" with thousands separators', () => {
    expect(rateLimitLabel(1000)).toBe('1,000/min');
    expect(rateLimitLabel(5000)).toBe('5,000/min');
    expect(rateLimitLabel(100)).toBe('100/min');
  });

  it('coerces a numeric string', () => {
    expect(rateLimitLabel('2000')).toBe('2,000/min');
  });

  it('is em-dash safe for missing / non-numeric / negative values', () => {
    expect(rateLimitLabel(undefined)).toBe('—');
    expect(rateLimitLabel(null)).toBe('—');
    expect(rateLimitLabel('')).toBe('—');
    expect(rateLimitLabel('abc')).toBe('—');
    expect(rateLimitLabel(-1)).toBe('—');
  });
});

describe('environmentLabel (TASK-395 P1-5)', () => {
  it('returns the trimmed environment string', () => {
    expect(environmentLabel('production')).toBe('production');
    expect(environmentLabel('  staging ')).toBe('staging');
  });

  it('is em-dash safe for missing / blank / non-string values', () => {
    expect(environmentLabel(undefined)).toBe('—');
    expect(environmentLabel('   ')).toBe('—');
    expect(environmentLabel(42)).toBe('—');
  });
});

describe('normalizeIpList / ipAllowlistSummary (TASK-395 P1-5)', () => {
  it('drops blanks + trims when normalizing', () => {
    expect(normalizeIpList(['10.0.0.0/8', '', '  192.168.1.1 '])).toEqual(['10.0.0.0/8', '192.168.1.1']);
    expect(normalizeIpList('not-an-array')).toEqual([]);
  });

  it('summarizes an empty allowlist as "Any IP" (no restriction)', () => {
    expect(ipAllowlistSummary([])).toBe('Any IP');
    expect(ipAllowlistSummary(undefined)).toBe('Any IP');
    expect(ipAllowlistSummary(['   '])).toBe('Any IP');
  });

  it('shows the single CIDR, or a count for many', () => {
    expect(ipAllowlistSummary(['10.0.0.0/8'])).toBe('10.0.0.0/8');
    expect(ipAllowlistSummary(['10.0.0.0/8', '192.168.0.0/16', '172.16.0.0/12'])).toBe('3 IPs');
  });
});

describe('parseIpInput (TASK-395 P1-5)', () => {
  it('splits on commas / whitespace / newlines and trims', () => {
    expect(parseIpInput('10.0.0.0/8, 192.168.1.1\n172.16.0.0/12')).toEqual(['10.0.0.0/8', '192.168.1.1', '172.16.0.0/12']);
  });

  it('returns [] for empty / whitespace input (no restriction)', () => {
    expect(parseIpInput('')).toEqual([]);
    expect(parseIpInput('   ,  \n ')).toEqual([]);
  });
});
