import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCounter } from '../../../../hooks/registries/use-counter';

describe('useCounter', () => {
  it('initializes with default value (0)', () => {
    const { result } = renderHook(() => useCounter());
    expect(result.current[0]).toBe(0);
  });

  it('initializes with provided value', () => {
    const { result } = renderHook(() => useCounter(10));
    expect(result.current[0]).toBe(10);
  });

  it('increments', () => {
    const { result } = renderHook(() => useCounter(0));
    act(() => result.current[1].inc());
    expect(result.current[0]).toBe(1);
    act(() => result.current[1].inc());
    expect(result.current[0]).toBe(2);
  });

  it('decrements', () => {
    const { result } = renderHook(() => useCounter(5));
    act(() => result.current[1].dec());
    expect(result.current[0]).toBe(4);
  });

  it('sets explicit value', () => {
    const { result } = renderHook(() => useCounter(0));
    act(() => result.current[1].set(42));
    expect(result.current[0]).toBe(42);
  });

  it('sets value with function', () => {
    const { result } = renderHook(() => useCounter(10));
    act(() => result.current[1].set((v) => v * 2));
    expect(result.current[0]).toBe(20);
  });

  it('resets to initial value', () => {
    const { result } = renderHook(() => useCounter(5));
    act(() => result.current[1].inc());
    act(() => result.current[1].inc());
    expect(result.current[0]).toBe(7);
    act(() => result.current[1].reset());
    expect(result.current[0]).toBe(5);
  });
});
