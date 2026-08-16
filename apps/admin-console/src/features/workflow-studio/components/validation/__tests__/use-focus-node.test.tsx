/**
 * `useFocusNode` (TASK-719 Task 14) — selects AND moves DOM focus, in both view modes.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFocusNode } from '../use-focus-node';

function flush(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

describe('useFocusNode', () => {
  it('selects the node and moves focus to the canvas node element (data-id, React Flow convention)', async () => {
    document.body.innerHTML = '<div class="react-flow__node" data-id="n1" tabindex="0"></div>';
    const onSelect = vi.fn();
    const { result } = renderHook(() => useFocusNode({ viewMode: 'canvas', onSelect }));
    result.current('n1');
    expect(onSelect).toHaveBeenCalledWith('n1');
    await flush();
    expect(document.activeElement).toBe(document.querySelector('[data-id="n1"]'));
  });

  it('selects the node and moves focus into the list-editor row (data-workflow-node-row-id) — a focusable descendant when the row itself is not focusable', async () => {
    document.body.innerHTML = '<li data-workflow-node-row-id="n1"><button>Configure</button></li>';
    const onSelect = vi.fn();
    const { result } = renderHook(() => useFocusNode({ viewMode: 'list', onSelect }));
    result.current('n1');
    expect(onSelect).toHaveBeenCalledWith('n1');
    await flush();
    expect(document.activeElement).toBe(document.querySelector('button'));
  });

  it('does nothing (no throw) when the target is not in the DOM yet', async () => {
    document.body.innerHTML = '';
    const onSelect = vi.fn();
    const { result } = renderHook(() => useFocusNode({ viewMode: 'canvas', onSelect }));
    expect(() => result.current('missing')).not.toThrow();
    await flush();
  });
});
