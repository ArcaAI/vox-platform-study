/**
 * `useFocusNode` — selects AND moves DOM focus onto the canvas node.
 *
 * TASK-893 OD-1: the list-editor branch (`data-workflow-node-row-id`) went with `GraphListEditor`,
 * and with it the `viewMode` argument. The canvas is the only view, so there is one selector.
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
    const { result } = renderHook(() => useFocusNode({ onSelect }));
    result.current('n1');
    expect(onSelect).toHaveBeenCalledWith('n1');
    await flush();
    expect(document.activeElement).toBe(document.querySelector('[data-id="n1"]'));
  });

  it('falls back to a focusable descendant when the node wrapper itself is not focusable', async () => {
    document.body.innerHTML = '<div class="react-flow__node" data-id="n1"><button>Configure</button></div>';
    const onSelect = vi.fn();
    const { result } = renderHook(() => useFocusNode({ onSelect }));
    result.current('n1');
    await flush();
    expect(document.activeElement).toBe(document.querySelector('button'));
  });

  it('does nothing (no throw) when the target is not in the DOM yet', async () => {
    document.body.innerHTML = '';
    const onSelect = vi.fn();
    const { result } = renderHook(() => useFocusNode({ onSelect }));
    expect(() => result.current('missing')).not.toThrow();
    await flush();
  });
});
