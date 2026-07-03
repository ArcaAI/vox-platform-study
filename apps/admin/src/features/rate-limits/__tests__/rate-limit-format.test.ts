import { describe, expect, it } from 'vitest';
import { AUTH_CRITICAL_TIER, formatLimitPerWindow, formatWindow, sourceColorRole, tierDescription } from '../rate-limit-format';

// TASK-403 — pure presentation logic for the Rate Limits surface (design frame
// `14` v2: tier cards "100 req / 60s" + db/code/default provenance pills).
describe('formatWindow', () => {
  it('renders whole seconds', () => {
    expect(formatWindow(60_000)).toBe('60s');
    expect(formatWindow(1_000)).toBe('1s');
  });

  it('renders minutes for whole-minute windows above 60s', () => {
    expect(formatWindow(120_000)).toBe('2m');
  });

  it('keeps sub-second windows in ms', () => {
    expect(formatWindow(500)).toBe('500ms');
  });
});

describe('formatLimitPerWindow', () => {
  it('renders the design string shape', () => {
    expect(formatLimitPerWindow(100, 60_000)).toBe('100 req / 60s');
    expect(formatLimitPerWindow(1, 1_000)).toBe('1 req / 1s');
  });
});

describe('sourceColorRole', () => {
  it('maps db overrides to hope, code to info, default to neutral', () => {
    expect(sourceColorRole('db')).toBe('hope');
    expect(sourceColorRole('code')).toBe('info');
    expect(sourceColorRole('default')).toBe('neutral');
  });
});

describe('tier metadata', () => {
  it('flags strict as the auth-critical baseline with a description per tier', () => {
    expect(AUTH_CRITICAL_TIER).toBe('strict');
    expect(tierDescription('strict')).toContain('auth');
    expect(tierDescription('default')).toBeTruthy();
    expect(tierDescription('heavy')).toBeTruthy();
    expect(tierDescription('relaxed')).toBeTruthy();
  });
});
