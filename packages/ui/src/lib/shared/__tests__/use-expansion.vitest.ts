import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useExpansion } from '../use-expansion';

describe('useExpansion (extracted headless controller)', () => {
  it('toggles an id on and off (uncontrolled, multiple by default)', () => {
    const { result } = renderHook(() => useExpansion());
    expect(result.current.expandedIds).toEqual([]);
    act(() => result.current.toggle('a'));
    expect(result.current.expandedIds).toEqual(['a']);
    expect(result.current.isExpanded('a')).toBe(true);
    act(() => result.current.toggle('a'));
    expect(result.current.expandedIds).toEqual([]);
    expect(result.current.isExpanded('a')).toBe(false);
  });

  it('multiple mode keeps several ids open at once', () => {
    const { result } = renderHook(() => useExpansion({ mode: 'multiple' }));
    act(() => result.current.toggle('a'));
    act(() => result.current.toggle('b'));
    expect(result.current.expandedIds).toEqual(['a', 'b']);
  });

  it('single mode keeps only the most recently opened id', () => {
    const { result } = renderHook(() => useExpansion({ mode: 'single' }));
    act(() => result.current.toggle('a'));
    expect(result.current.expandedIds).toEqual(['a']);
    act(() => result.current.toggle('b'));
    expect(result.current.expandedIds).toEqual(['b']);
  });

  it('seeds uncontrolled state from defaultExpandedIds (once)', () => {
    const { result } = renderHook(() => useExpansion({ defaultExpandedIds: ['x', 'y'] }));
    expect(result.current.expandedIds).toEqual(['x', 'y']);
    act(() => result.current.setExpanded('x', false));
    expect(result.current.expandedIds).toEqual(['y']);
  });

  it('is controlled when value is provided: never self-updates, always calls onChange', () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(({ value }: { value: string[] }) => useExpansion({ value, onChange }), {
      initialProps: { value: ['a'] },
    });
    expect(result.current.expandedIds).toEqual(['a']);
    act(() => result.current.toggle('b'));
    // Controlled: internal value does not change until the parent passes a new prop.
    expect(result.current.expandedIds).toEqual(['a']);
    expect(onChange).toHaveBeenCalledWith(['a', 'b']);
    rerender({ value: ['a', 'b'] });
    expect(result.current.expandedIds).toEqual(['a', 'b']);
  });

  it('setExpanded is idempotent and fires the per-item onExpandedChange only on real change', () => {
    const onExpandedChange = vi.fn();
    const { result } = renderHook(() => useExpansion({ onExpandedChange }));
    act(() => result.current.setExpanded('a', true));
    expect(onExpandedChange).toHaveBeenCalledWith('a', true);
    onExpandedChange.mockClear();
    // No-op (already expanded) → no callback.
    act(() => result.current.setExpanded('a', true));
    expect(onExpandedChange).not.toHaveBeenCalled();
  });
});
