import { describe, expect, it } from 'vitest';
import type { CapabilityUsageRow, TrialInfo } from '@arcaai/vox';
import {
  capabilityLabel,
  formatBytes,
  formatCapabilityValue,
  isByteCapability,
  quotaErrorMessage,
  trialCountdownText,
  trialTone,
  usageColorRole,
  usageLabel,
  usagePercent,
  usageTone,
} from '../entitlements-format';

const row = (over: Partial<CapabilityUsageRow>): CapabilityUsageRow => ({
  key: 'users',
  limit: 50,
  used: 10,
  remaining: 40,
  unlimited: false,
  nearLimit: false,
  exceeded: false,
  ...over,
});

describe('capabilityLabel', () => {
  it('maps known keys and falls back to the raw key', () => {
    expect(capabilityLabel('users')).toBe('Users / seats');
    expect(capabilityLabel('storageBytes')).toBe('Storage');
    // TASK-392 — concurrency capability row surfaced in the usage snapshot.
    expect(capabilityLabel('concurrentSessions')).toBe('Concurrent sessions');
    expect(capabilityLabel('somethingNew')).toBe('somethingNew');
  });
});

describe('byte vs count formatting', () => {
  it('detects byte capabilities', () => {
    expect(isByteCapability('storageBytes')).toBe(true);
    expect(isByteCapability('users')).toBe(false);
  });

  it('formats bytes compactly and uses ∞ for unlimited', () => {
    expect(formatBytes(null)).toBe('∞');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5 GB');
  });

  it('routes value formatting by key semantics', () => {
    expect(formatCapabilityValue('storageBytes', 2 * 1024 * 1024)).toBe('2 MB');
    expect(formatCapabilityValue('users', 1500)).toBe('1,500');
    expect(formatCapabilityValue('users', null)).toBe('∞');
  });
});

describe('usageLabel', () => {
  it('renders used / limit with ∞ and — sentinels', () => {
    expect(usageLabel(row({ used: 10, limit: 50 }))).toBe('10 / 50');
    expect(usageLabel(row({ unlimited: true, limit: null }))).toBe('10 / ∞');
    expect(usageLabel(row({ used: null }))).toBe('— / 50');
    expect(usageLabel(row({ key: 'storageBytes', used: 1024, limit: 1024 * 1024 }))).toBe('1 KB / 1 MB');
  });
});

describe('usagePercent', () => {
  it('computes a clamped 0–100 percentage', () => {
    expect(usagePercent(row({ used: 10, limit: 50 }))).toBe(20);
    expect(usagePercent(row({ used: 200, limit: 50, exceeded: true }))).toBe(100);
  });

  it('returns null when unlimited or unmetered', () => {
    expect(usagePercent(row({ unlimited: true, limit: null }))).toBeNull();
    expect(usagePercent(row({ used: null }))).toBeNull();
    expect(usagePercent(row({ limit: 0 }))).toBeNull();
  });
});

describe('usageTone / usageColorRole', () => {
  it('maps server flags to tones', () => {
    expect(usageTone(row({ unlimited: true }))).toBe('unlimited');
    expect(usageTone(row({ used: null }))).toBe('unmetered');
    expect(usageTone(row({ exceeded: true }))).toBe('exceeded');
    expect(usageTone(row({ nearLimit: true }))).toBe('near');
    expect(usageTone(row({}))).toBe('ok');
  });

  it('maps tones to color roles', () => {
    expect(usageColorRole(row({ exceeded: true }))).toBe('destructive');
    expect(usageColorRole(row({ nearLimit: true }))).toBe('warning');
    expect(usageColorRole(row({}))).toBe('success');
    expect(usageColorRole(row({ unlimited: true }))).toBe('neutral');
  });
});

describe('trial clock', () => {
  const trial = (over: Partial<TrialInfo>): TrialInfo => ({ isTrial: true, trialEndsAt: null, daysRemaining: 10, expired: false, ...over });

  it('derives tone from trial state', () => {
    expect(trialTone(trial({ isTrial: false }))).toBe('none');
    expect(trialTone(trial({ expired: true }))).toBe('expired');
    expect(trialTone(trial({ daysRemaining: 2 }))).toBe('urgent');
    expect(trialTone(trial({ daysRemaining: 10 }))).toBe('info');
  });

  it('writes human countdown copy', () => {
    expect(trialCountdownText(trial({ isTrial: false }))).toBe('');
    expect(trialCountdownText(trial({ expired: true }))).toContain('expired');
    expect(trialCountdownText(trial({ daysRemaining: 0 }))).toBe('Trial ends today');
    expect(trialCountdownText(trial({ daysRemaining: 1 }))).toBe('1 day left on trial');
    expect(trialCountdownText(trial({ daysRemaining: 5 }))).toBe('5 days left on trial');
  });
});

describe('quotaErrorMessage (blocked-action UX)', () => {
  it('maps the server enforcement statuses to actionable copy', () => {
    expect(quotaErrorMessage({ status: 409 })).toMatch(/plan limit/i);
    expect(quotaErrorMessage({ status: 429 })).toMatch(/month/i);
    expect(quotaErrorMessage({ status: 413 })).toMatch(/storage/i);
    expect(quotaErrorMessage({ status: 403 })).toMatch(/current plan/i);
  });

  it('reads the status from a nested AgenticError context', () => {
    expect(quotaErrorMessage({ context: { status: 429 } })).toMatch(/month/i);
    expect(quotaErrorMessage({ statusCode: 413 })).toMatch(/storage/i);
  });

  it('returns undefined for non-quota errors', () => {
    expect(quotaErrorMessage({ status: 500 })).toBeUndefined();
    expect(quotaErrorMessage(new Error('boom'))).toBeUndefined();
    expect(quotaErrorMessage(null)).toBeUndefined();
  });
});
