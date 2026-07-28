/**
 * StepStats must render AD-1 snake_case fields from trajectory emitters, not
 * only the camelCase keys the console historically expected.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StepStats } from '../step-stats';

afterEach(() => {
  cleanup();
});

describe('StepStats', () => {
  it('renders camelCase GenerationStats as a key/value grid', () => {
    render(
      <StepStats
        stats={{
          ttftMs: 120,
          tokensPerSecond: 45.2,
          stopReason: 'stop',
          promptTokens: 100,
          completionTokens: 50,
          model: 'gemma-4-medical',
        }}
      />,
    );

    expect(screen.getByText('TTFT')).toBeDefined();
    expect(screen.getByText('120 ms')).toBeDefined();
    expect(screen.getByText('tok/s')).toBeDefined();
    expect(screen.getByText('45.2')).toBeDefined();
    expect(screen.getByText('stop reason')).toBeDefined();
    expect(screen.getByText('stop')).toBeDefined();
    expect(screen.queryByText(/"ttftMs"/)).toBeNull();
  });

  it('renders snake_case AD-1 GenerationStats (trajectory wire shape)', () => {
    render(
      <StepStats
        stats={{
          ttft_ms: 210,
          tokens_per_second: 42.5,
          stop_reason: 'length',
          prompt_tokens: 80,
          predicted_tokens: 40,
          total_ms: 900,
          model: 'gemma-4-medical',
        }}
      />,
    );

    expect(screen.getByText('TTFT')).toBeDefined();
    expect(screen.getByText('210 ms')).toBeDefined();
    expect(screen.getByText('tok/s')).toBeDefined();
    expect(screen.getByText('42.5')).toBeDefined();
    expect(screen.getByText('total')).toBeDefined();
    expect(screen.getByText('900 ms')).toBeDefined();
    expect(screen.getByText('prompt tok')).toBeDefined();
    expect(screen.getByText('80')).toBeDefined();
    expect(screen.getByText('completion tok')).toBeDefined();
    expect(screen.getByText('40')).toBeDefined();
    expect(screen.getByText('stop reason')).toBeDefined();
    expect(screen.getByText('length')).toBeDefined();
    // Must not fall back to raw JSON dump.
    expect(screen.queryByText(/"ttft_ms"/)).toBeNull();
  });
});
