import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useInterval } from '../../../../hooks/registries/use-interval';

describe('useInterval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the callback at the specified interval', () => {
    const fn = vi.fn();
    renderHook(() => useInterval(fn, 1000));

    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not start when delay is undefined', () => {
    const fn = vi.fn();
    renderHook(() => useInterval(fn, undefined));
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('calls immediately when immediate option is set', () => {
    const fn = vi.fn();
    renderHook(() => useInterval(fn, 1000, { immediate: true }));
    expect(fn).toHaveBeenCalledOnce();
  });

  it('returns a clear function', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useInterval(fn, 1000));
    result.current();
    vi.advanceTimersByTime(3000);
    expect(fn).not.toHaveBeenCalled();
  });
});
