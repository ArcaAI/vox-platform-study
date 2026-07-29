import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBoolean } from '../../../../hooks/registries/use-boolean';

describe('useBoolean', () => {
  it('initializes with default value (false)', () => {
    const { result } = renderHook(() => useBoolean());
    expect(result.current[0]).toBe(false);
  });

  it('initializes with provided value', () => {
    const { result } = renderHook(() => useBoolean(true));
    expect(result.current[0]).toBe(true);
  });

  it('toggles value', () => {
    const { result } = renderHook(() => useBoolean(false));
    act(() => result.current[1].toggle());
    expect(result.current[0]).toBe(true);
    act(() => result.current[1].toggle());
    expect(result.current[0]).toBe(false);
  });

  it('sets true', () => {
    const { result } = renderHook(() => useBoolean(false));
    act(() => result.current[1].setTrue());
    expect(result.current[0]).toBe(true);
  });

  it('sets false', () => {
    const { result } = renderHook(() => useBoolean(true));
    act(() => result.current[1].setFalse());
    expect(result.current[0]).toBe(false);
  });

  it('sets explicit value', () => {
    const { result } = renderHook(() => useBoolean(false));
    act(() => result.current[1].set(true));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1].set(false));
    expect(result.current[0]).toBe(false);
  });
});
