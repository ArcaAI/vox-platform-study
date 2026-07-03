/**
 * TASK-407 — Harness surface display helpers.
 * Design: `unbuilt-super-admin-surfaces.md` §2 "Harness" (spec-only): sub-tabs
 * Policy · Eval runs · Audit trail · Gate queue; Temporal workflows degrade
 * honestly when the harness service (`:8866`) is down.
 */

import { describe, it, expect } from 'vitest';
import { formatSeconds, policySourceLabel, policySourceRole, workflowStatusRole, chainVerdict } from '../harness-display';

describe('formatSeconds', () => {
  it('renders whole hours / minutes / seconds compactly', () => {
    expect(formatSeconds(86_400)).toBe('24h');
    expect(formatSeconds(43_200)).toBe('12h');
    expect(formatSeconds(5_400)).toBe('1h 30m');
    expect(formatSeconds(90)).toBe('1m 30s');
    expect(formatSeconds(45)).toBe('45s');
  });

  it('returns em-dash for null/undefined/negative', () => {
    expect(formatSeconds(null)).toBe('—');
    expect(formatSeconds(undefined)).toBe('—');
    expect(formatSeconds(-5)).toBe('—');
  });
});

describe('policySource pills', () => {
  it('labels the three resolution sources', () => {
    expect(policySourceLabel('tenant')).toBe('Tenant override');
    expect(policySourceLabel('system-default')).toBe('Platform default');
    expect(policySourceLabel('code-default')).toBe('Code default');
  });

  it('colors tenant=hope, system=info, code=neutral', () => {
    expect(policySourceRole('tenant')).toBe('hope');
    expect(policySourceRole('system-default')).toBe('info');
    expect(policySourceRole('code-default')).toBe('neutral');
  });
});

describe('workflowStatusRole', () => {
  it('maps Temporal statuses to color roles', () => {
    expect(workflowStatusRole('RUNNING')).toBe('info');
    expect(workflowStatusRole('COMPLETED')).toBe('success');
    expect(workflowStatusRole('FAILED')).toBe('destructive');
    expect(workflowStatusRole('TERMINATED')).toBe('destructive');
    expect(workflowStatusRole('CANCELED')).toBe('neutral');
    expect(workflowStatusRole('TIMED_OUT')).toBe('warning');
    expect(workflowStatusRole('anything-else')).toBe('neutral');
  });
});

describe('chainVerdict', () => {
  it('renders the WORM chain integrity badge model', () => {
    expect(chainVerdict({ valid: true, brokenAtIndex: null })).toEqual({ label: 'Chain verified', colorRole: 'success' });
    expect(chainVerdict({ valid: false, brokenAtIndex: 7 })).toEqual({ label: 'Chain broken at #7', colorRole: 'destructive' });
    expect(chainVerdict(null)).toEqual({ label: 'Not verified', colorRole: 'neutral' });
  });
});
