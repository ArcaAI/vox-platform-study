import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import usePrevious from '../../../../hooks/registries/use-previous';

describe('usePrevious', () => {
  it('returns undefined on first render', () => {
    const { result } = renderHook(() => usePrevious(0));
    expect(result.current).toBeUndefined();
  });

  it('returns previous value after update', () => {
    const { result, rerender } = renderHook(({ val }) => usePrevious(val), {
      initialProps: { val: 0 },
    });
    expect(result.current).toBeUndefined();

    rerender({ val: 1 });
    expect(result.current).toBe(0);

    rerender({ val: 2 });
    expect(result.current).toBe(1);
  });

  it('does not update when value is the same', () => {
    const { result, rerender } = renderHook(({ val }) => usePrevious(val), {
      initialProps: { val: 'a' },
    });

    rerender({ val: 'b' });
    expect(result.current).toBe('a');

    rerender({ val: 'b' });
    expect(result.current).toBe('a');
  });
});
