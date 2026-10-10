import { describe, expect, it } from 'vitest';
import { blockingSummary } from './validation-summary';

const f = (severity: 'ERROR' | 'WARNING', message: string) => ({ severity, code: 'X', path: 'p', message });

describe('blockingSummary', () => {
  it('is null when nothing blocks', () => {
    expect(blockingSummary(null)).toBeNull();
    expect(blockingSummary({ checkedAt: '', blocking: false, findings: [f('WARNING', 'w')] })).toBeNull();
  });
  it('lists error findings, capped at three, ignoring warnings', () => {
    const report = { checkedAt: '', blocking: true, findings: [f('WARNING', 'w'), f('ERROR', 'a'), f('ERROR', 'b'), f('ERROR', 'c'), f('ERROR', 'd')] };
    expect(blockingSummary(report)).toBe('a; b; c (+1 more)');
  });
});
