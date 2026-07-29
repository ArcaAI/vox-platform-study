import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTimeout } from '../../../../hooks/registries/use-timeout';

describe('useTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the callback after the delay', () => {
    const fn = vi.fn();
    renderHook(() => useTimeout(fn, 1000));

    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not call again after firing', () => {
    const fn = vi.fn();
    renderHook(() => useTimeout(fn, 500));

    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('returns a clear function', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useTimeout(fn, 1000));
    result.current();
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
  });
});
