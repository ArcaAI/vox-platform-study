import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { AiCapability } from '@arcaai/domains';

import { projectCapabilityBurndown } from '../budget-burndown';

describe('projectCapabilityBurndown', () => {
  it('unlimited (null allowance) never projects to exceed', () => {
    const line = projectCapabilityBurndown(AiCapability.LLM, new Decimal(1_000_000), null, 0.5);
    expect(line).toEqual({ capability: AiCapability.LLM, allowance: null, usedToDate: '1000000.000000', projectedTotal: null, projectedToExceed: false, utilizationPercent: null });
  });

  it('projects linearly: half the month elapsed, half the allowance used -> on pace, not exceeding', () => {
    const line = projectCapabilityBurndown(AiCapability.TTS, new Decimal(500), new Decimal(1000), 0.5);
    expect(line.projectedTotal).toBe('1000.000000');
    expect(line.projectedToExceed).toBe(false);
    expect(line.utilizationPercent).toBeCloseTo(50, 6);
  });

  it('flags projectedToExceed when the linear projection crosses the allowance', () => {
    // 10 days in (fraction ~0.333), already used 400 of a 1000 allowance -> projects to 1200
    const line = projectCapabilityBurndown(AiCapability.STT, new Decimal(400), new Decimal(1000), 1 / 3);
    expect(new Decimal(line.projectedTotal!).greaterThan(1000)).toBe(true);
    expect(line.projectedToExceed).toBe(true);
  });

  it('clamps negative usage to zero (defensive)', () => {
    const line = projectCapabilityBurndown(AiCapability.NLP, new Decimal(-5), new Decimal(100), 0.5);
    expect(line.usedToDate).toBe('0.000000');
  });

  it('handles a zero allowance without dividing by zero', () => {
    const zeroUsed = projectCapabilityBurndown(AiCapability.EMBEDDING, new Decimal(0), new Decimal(0), 0.5);
    expect(zeroUsed.utilizationPercent).toBe(0);
    const someUsed = projectCapabilityBurndown(AiCapability.EMBEDDING, new Decimal(5), new Decimal(0), 0.5);
    expect(someUsed.utilizationPercent).toBe(100);
    expect(someUsed.projectedToExceed).toBe(true);
  });

  it('clamps fractionElapsed into (0, 1] so an early-period call does not divide by ~0', () => {
    const line = projectCapabilityBurndown(AiCapability.LLM, new Decimal(10), new Decimal(1000), 0);
    expect(Number.isFinite(Number(line.projectedTotal))).toBe(true);
  });
});
