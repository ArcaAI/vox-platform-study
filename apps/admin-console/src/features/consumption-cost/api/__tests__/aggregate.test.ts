import { describe, expect, it } from 'vitest';

import { aggregateCostByCapability, pickDefaultSeries, sumMicrosMap } from '../aggregate';
import type { UsageSummaryLine } from '../types';

function line(capability: string, costMicros: string, over: Partial<UsageSummaryLine> = {}): UsageSummaryLine {
  return { capability, provider: 'p', model: '', unit: 'INPUT_TOKEN', quantity: '1', costMicros, ...over };
}

describe('aggregateCostByCapability', () => {
  it('sums costMicros per capability, descending by cost', () => {
    const rows = aggregateCostByCapability([line('LLM', '100'), line('LLM', '250'), line('STT', '400'), line('TTS', '50')]);
    expect(rows).toEqual([
      { capability: 'STT', costMicros: '400' },
      { capability: 'LLM', costMicros: '350' },
      { capability: 'TTS', costMicros: '50' },
    ]);
  });

  it('stays exact beyond Number.MAX_SAFE_INTEGER (BigInt sum)', () => {
    const big = '9007199254740993'; // 2^53 + 1 — loses precision as a JS number
    expect(aggregateCostByCapability([line('LLM', big), line('LLM', '1')])).toEqual([{ capability: 'LLM', costMicros: '9007199254740994' }]);
  });

  it('breaks cost ties by capability name for a stable order', () => {
    expect(aggregateCostByCapability([line('TTS', '10'), line('LLM', '10')])).toEqual([
      { capability: 'LLM', costMicros: '10' },
      { capability: 'TTS', costMicros: '10' },
    ]);
  });

  it('tolerates a malformed micros string as 0', () => {
    expect(aggregateCostByCapability([line('LLM', 'oops'), line('LLM', '5')])).toEqual([{ capability: 'LLM', costMicros: '5' }]);
  });

  it('empty in, empty out', () => {
    expect(aggregateCostByCapability([])).toEqual([]);
  });
});

describe('sumMicrosMap', () => {
  it('sums map values as BigInt', () => {
    expect(sumMicrosMap({ LLM: '100', STT: '250' })).toBe('350');
  });

  it('nullish -> "0"', () => {
    expect(sumMicrosMap(null)).toBe('0');
    expect(sumMicrosMap(undefined)).toBe('0');
    expect(sumMicrosMap({})).toBe('0');
  });
});

describe('pickDefaultSeries', () => {
  it('picks the highest-cost capability, and within it the line with the largest quantity', () => {
    const lines = [
      line('LLM', '100', { unit: 'INPUT_TOKEN', quantity: '10' }),
      line('STT', '400', { unit: 'AUDIO_SECOND', quantity: '9000' }),
      line('STT', '400', { unit: 'GPU_SECOND', quantity: '30' }),
    ];
    expect(pickDefaultSeries(lines)).toEqual({ capability: 'STT', unit: 'AUDIO_SECOND' });
  });

  it('null in, null out', () => {
    expect(pickDefaultSeries([])).toBeNull();
  });
});
