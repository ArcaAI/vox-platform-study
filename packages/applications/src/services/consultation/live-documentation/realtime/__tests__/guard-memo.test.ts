/**
 * task 11 — guard memoization on `(guard, config, inputHash)`.
 *
 * The headline case is the one the key exists for: two thresholds over identical
 * input must produce TWO verdicts. Keying on input alone would serve one
 * generation node the other's answer — a document marked grounded under a
 * threshold it was never checked against.
 */
import { describe, it, expect, vi } from 'vitest';
import { GuardMemo, guardMemoKey } from '../guard-memo';

const NOTE = 'Assessment: likely viral upper respiratory infection.';

describe('task 11 — guard memoization, with CONFIG in the key', () => {
  it('THE POINT: two thresholds over the same input are two verdicts, not one', async () => {
    const memo = new GuardMemo();
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ verdict: 'grounded' })
      .mockResolvedValueOnce({ verdict: 'ungrounded' });

    const strict = await memo.resolve('guardrail.groundedness', { threshold: 0.9 }, NOTE, exec);
    const lenient = await memo.resolve('guardrail.groundedness', { threshold: 0.6 }, NOTE, exec);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(strict).toEqual({ verdict: 'grounded' });
    expect(lenient).toEqual({ verdict: 'ungrounded' });
    expect(memo.hits).toBe(0);
  });

  it('serves a repeat of the SAME (guard, config, input) from cache', async () => {
    const memo = new GuardMemo();
    const exec = vi.fn().mockResolvedValue({ verdict: 'grounded' });

    await memo.resolve('guardrail.groundedness', { threshold: 0.9 }, NOTE, exec);
    const second = await memo.resolve('guardrail.groundedness', { threshold: 0.9 }, NOTE, exec);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ verdict: 'grounded' });
    expect(memo.hits).toBe(1);
  });

  it('different guards never share an entry, even at identical config and input', async () => {
    const memo = new GuardMemo();
    const exec = vi.fn().mockResolvedValue({ verdict: 'grounded' });

    await memo.resolve('guardrail.groundedness', {}, NOTE, exec);
    await memo.resolve('guardrail.pii', {}, NOTE, exec);

    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('different input, same config: two calls (the cache is not keyed on config alone)', async () => {
    const memo = new GuardMemo();
    const exec = vi.fn().mockResolvedValue({ verdict: 'grounded' });

    await memo.resolve('guardrail.groundedness', { threshold: 0.9 }, 'note A', exec);
    await memo.resolve('guardrail.groundedness', { threshold: 0.9 }, 'note B', exec);

    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('config key ORDER does not split the cache, but config VALUES do', () => {
    expect(guardMemoKey('g', { a: 1, b: 2 }, NOTE)).toBe(guardMemoKey('g', { b: 2, a: 1 }, NOTE));
    expect(guardMemoKey('g', { threshold: 0.9 }, NOTE)).not.toBe(guardMemoKey('g', { threshold: 0.6 }, NOTE));
  });

  it('two nodes racing the same guard share ONE in-flight call rather than issuing two', async () => {
    const memo = new GuardMemo();
    let resolveExec: (v: unknown) => void = () => {};
    const exec = vi.fn(() => new Promise((resolve) => (resolveExec = resolve)));

    const both = Promise.all([
      memo.resolve('guardrail.groundedness', { threshold: 0.9 }, NOTE, exec as never),
      memo.resolve('guardrail.groundedness', { threshold: 0.9 }, NOTE, exec as never),
    ]);
    resolveExec({ verdict: 'grounded' });

    expect(await both).toEqual([{ verdict: 'grounded' }, { verdict: 'grounded' }]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('a REJECTED guard is evicted so a transient outage does not pin a failure for the flush', async () => {
    const memo = new GuardMemo();
    const exec = vi.fn().mockRejectedValueOnce(new Error('gate down')).mockResolvedValue({ verdict: 'unverified' });

    await expect(memo.resolve('guardrail.groundedness', {}, NOTE, exec)).rejects.toThrow('gate down');
    await expect(memo.resolve('guardrail.groundedness', {}, NOTE, exec)).resolves.toEqual({ verdict: 'unverified' });
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
