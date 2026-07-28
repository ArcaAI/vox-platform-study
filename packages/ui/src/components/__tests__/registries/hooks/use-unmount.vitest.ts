import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUnmount } from '../../../../hooks/registries/use-unmount';

describe('useUnmount', () => {
  it('calls the callback on unmount', () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => useUnmount(fn));
    expect(fn).not.toHaveBeenCalled();
    unmount();
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not call the callback on rerender', () => {
    const fn = vi.fn();
    const { rerender } = renderHook(() => useUnmount(fn));
    rerender();
    expect(fn).not.toHaveBeenCalled();
  });
});
