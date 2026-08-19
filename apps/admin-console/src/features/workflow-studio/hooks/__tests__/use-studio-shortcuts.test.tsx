/**
 * TASK-719 UX pass — editor keyboard shortcuts. The load-bearing assertion is the NEGATIVE one:
 * a chord fired while focus is inside a text field must fall through to the browser, or undo in
 * the inspector's inputs would silently revert graph edits instead of typing.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useStudioShortcuts } from '../use-studio-shortcuts';

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function setup(enabled = true) {
  const handlers = { onUndo: vi.fn(), onRedo: vi.fn(), onDuplicate: vi.fn() };
  renderHook(() => useStudioShortcuts({ enabled, ...handlers }));
  return handlers;
}

describe('useStudioShortcuts', () => {
  it('maps Ctrl/Cmd+Z to undo and Shift+Ctrl+Z / Ctrl+Y to redo', () => {
    const handlers = setup();
    press('z', { ctrlKey: true });
    expect(handlers.onUndo).toHaveBeenCalledTimes(1);
    press('z', { metaKey: true });
    expect(handlers.onUndo).toHaveBeenCalledTimes(2);
    press('z', { ctrlKey: true, shiftKey: true });
    press('y', { ctrlKey: true });
    expect(handlers.onRedo).toHaveBeenCalledTimes(2);
  });

  it('maps Ctrl/Cmd+D to duplicate', () => {
    const handlers = setup();
    press('d', { metaKey: true });
    expect(handlers.onDuplicate).toHaveBeenCalledTimes(1);
  });

  it('ignores every chord while focus is in a text field', () => {
    const handlers = setup();
    const input = document.createElement('input');
    document.body.append(input);
    const event = press('z', { ctrlKey: true }, input);
    expect(handlers.onUndo).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    input.remove();
  });

  it('does nothing when disabled (read-only definition) or without a modifier', () => {
    const handlers = setup(false);
    press('z', { ctrlKey: true });
    expect(handlers.onUndo).not.toHaveBeenCalled();

    const live = setup(true);
    press('z');
    expect(live.onUndo).not.toHaveBeenCalled();
  });
});
