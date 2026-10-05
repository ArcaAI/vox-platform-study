/**
 * `FloatingPane` — TASK-1036 OD-17: the inspector (and palette) float over the canvas, snap to an
 * edge, and are movable AND resizable by pointer OR keyboard (WCAG 2.5.7 — dragging always has a
 * single-pointer / keyboard alternative). Geometry persists per pane in `localStorage`, which
 * must never be load-bearing (it throws in private windows), and a pane yields to a focused
 * element it would cover (WCAG 2.4.11).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { FloatingPane, floatingPaneStorageKey } from '../floating-pane';

function pane() {
  return screen.getByRole('region', { name: 'Inspector' });
}

function renderPane(props: Partial<React.ComponentProps<typeof FloatingPane>> = {}) {
  return render(
    <div data-testid="stage" className="relative">
      <button type="button">Canvas node</button>
      <FloatingPane id="inspector" title="Inspector" defaultDock="right" defaultWidth={320} {...props}>
        <p>Body copy</p>
        <button type="button">Inside the pane</button>
      </FloatingPane>
    </div>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FloatingPane — structure', () => {
  it('is a named region with the title as its heading and the children inside', () => {
    renderPane();
    expect(pane()).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Inspector' })).toBeTruthy();
    expect(screen.getByText('Body copy')).toBeTruthy();
  });

  it('floats over the canvas at md and up, and is a static stacked section below it', () => {
    renderPane();
    expect(pane().className).toContain('md:absolute');
    expect(pane().className).not.toMatch(/(^|\s)absolute(\s|$)/);
  });

  it('starts docked where the caller said, with the default width', () => {
    renderPane();
    expect(pane().getAttribute('data-dock')).toBe('right');
    expect(pane().getAttribute('data-width')).toBe('320');
  });

  it('offers a close control only when a handler is supplied', () => {
    const onClose = vi.fn();
    const { unmount } = renderPane();
    expect(screen.queryByRole('button', { name: 'Close Inspector' })).toBeNull();
    unmount();
    renderPane({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Close Inspector' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('0 axe violations', async () => {
    const { container } = renderPane({ onClose: vi.fn() });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('FloatingPane — collapse', () => {
  it('collapses to its header and announces the state', () => {
    renderPane();
    const toggle = screen.getByRole('button', { name: 'Collapse Inspector' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    const expand = screen.getByRole('button', { name: 'Expand Inspector' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Body copy')).toBeNull();
    fireEvent.click(expand);
    expect(screen.getByText('Body copy')).toBeTruthy();
  });

  it('keeps the body MOUNTED while collapsed so the content inside keeps its state', () => {
    renderPane({ keepMounted: true });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Inspector' }));
    const body = screen.getByText('Body copy', { selector: 'p' });
    expect(body.closest('[hidden]')).toBeTruthy();
  });
});

describe('FloatingPane — keyboard move and resize (WCAG 2.5.7)', () => {
  it('moves with the arrow keys from the grip, and a move un-docks the pane', () => {
    renderPane({ defaultDock: null, defaultPosition: { x: 40, y: 40 } });
    const grip = screen.getByRole('button', { name: 'Move Inspector' });
    expect(pane().getAttribute('data-x')).toBe('40');
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    expect(pane().getAttribute('data-x')).toBe('56');
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    expect(pane().getAttribute('data-y')).toBe('56');
    fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    expect(pane().getAttribute('data-x')).toBe('40');
    expect(pane().getAttribute('data-y')).toBe('40');
  });

  it('never moves off the top-left of the stage', () => {
    renderPane({ defaultDock: null, defaultPosition: { x: 4, y: 4 } });
    const grip = screen.getByRole('button', { name: 'Move Inspector' });
    fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    expect(pane().getAttribute('data-x')).toBe('0');
    expect(pane().getAttribute('data-y')).toBe('0');
  });

  it('moving a docked pane releases the dock', () => {
    renderPane();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Inspector' }), { key: 'ArrowLeft' });
    expect(pane().getAttribute('data-dock')).toBe('none');
  });

  it('resizes with Shift+Arrow from the grip, bounded by the minimum', () => {
    renderPane({ minWidth: 300 });
    const grip = screen.getByRole('button', { name: 'Move Inspector' });
    fireEvent.keyDown(grip, { key: 'ArrowLeft', shiftKey: true });
    expect(pane().getAttribute('data-width')).toBe('336');
    fireEvent.keyDown(grip, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(grip, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(grip, { key: 'ArrowRight', shiftKey: true });
    expect(pane().getAttribute('data-width')).toBe('300');
  });

  it('resizes from the edge handle with plain arrows too', () => {
    renderPane({ defaultDock: null, defaultPosition: { x: 0, y: 0 }, defaultHeight: 400 });
    const handle = screen.getByRole('separator', { name: 'Resize Inspector' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(pane().getAttribute('data-width')).toBe('336');
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(pane().getAttribute('data-height')).toBe('416');
  });

  it('snaps back to its dock from the Snap button', () => {
    renderPane();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Inspector' }), { key: 'ArrowLeft' });
    fireEvent.click(screen.getByRole('button', { name: 'Snap Inspector to the right' }));
    expect(pane().getAttribute('data-dock')).toBe('right');
  });

  it('docks to the left when that is its home edge', () => {
    renderPane({ defaultDock: 'left' });
    expect(pane().getAttribute('data-dock')).toBe('left');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Inspector' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('button', { name: 'Snap Inspector to the left' }));
    expect(pane().getAttribute('data-dock')).toBe('left');
  });

  it('moves with a single pointer drag on the grip', () => {
    renderPane({ defaultDock: null, defaultPosition: { x: 40, y: 40 } });
    const grip = screen.getByRole('button', { name: 'Move Inspector' });
    const mouse = (type: string, clientX: number, clientY: number) => new MouseEvent(type, { bubbles: true, clientX, clientY });
    act(() => {
      grip.dispatchEvent(mouse('pointerdown', 100, 100));
      window.dispatchEvent(mouse('pointermove', 130, 120));
      window.dispatchEvent(mouse('pointerup', 130, 120));
    });
    expect(pane().getAttribute('data-x')).toBe('70');
    expect(pane().getAttribute('data-y')).toBe('60');
  });
});

describe('FloatingPane — persistence is a convenience, never a dependency', () => {
  it('restores the last geometry for the same pane id', () => {
    const { unmount } = renderPane({ defaultDock: null, defaultPosition: { x: 40, y: 40 } });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Inspector' }), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Inspector' }));
    unmount();
    renderPane({ defaultDock: null, defaultPosition: { x: 40, y: 40 } });
    expect(pane().getAttribute('data-x')).toBe('56');
    expect(screen.getByRole('button', { name: 'Expand Inspector' })).toBeTruthy();
  });

  it('keys storage by pane id so two panes never share geometry', () => {
    renderPane({ defaultDock: null, defaultPosition: { x: 40, y: 40 } });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Inspector' }), { key: 'ArrowRight' });
    expect(window.localStorage.getItem(floatingPaneStorageKey('inspector'))).toContain('"x":56');
    expect(window.localStorage.getItem(floatingPaneStorageKey('palette'))).toBeNull();
  });

  it('renders and still moves when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderPane({ defaultDock: null, defaultPosition: { x: 40, y: 40 } });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Inspector' }), { key: 'ArrowRight' });
    expect(pane().getAttribute('data-x')).toBe('56');
  });

  it('ignores a corrupt stored value', () => {
    window.localStorage.setItem(floatingPaneStorageKey('inspector'), '{not json');
    renderPane();
    expect(pane().getAttribute('data-dock')).toBe('right');
  });
});

describe('FloatingPane — never obscures the focused element (WCAG 2.4.11)', () => {
  function rect(left: number, top: number, width: number, height: number): DOMRect {
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
  }

  it('yields (collapses) while a focused element outside it sits underneath, and restores after', () => {
    renderPane();
    vi.spyOn(pane(), 'getBoundingClientRect').mockReturnValue(rect(600, 0, 320, 400));
    const node = screen.getByRole('button', { name: 'Canvas node' });
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(rect(650, 100, 80, 30));

    act(() => node.focus());
    expect(pane().getAttribute('data-yielding')).toBe('true');
    expect(screen.queryByText('Body copy')).toBeNull();

    act(() => node.blur());
    expect(pane().getAttribute('data-yielding')).toBe('false');
    expect(screen.getByText('Body copy')).toBeTruthy();
  });

  it('does not yield for an element that is clear of the pane', () => {
    renderPane();
    vi.spyOn(pane(), 'getBoundingClientRect').mockReturnValue(rect(600, 0, 320, 400));
    const node = screen.getByRole('button', { name: 'Canvas node' });
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(rect(10, 100, 80, 30));
    act(() => node.focus());
    expect(pane().getAttribute('data-yielding')).toBe('false');
  });

  // TASK-1036 live check (owner: "the panes are resized to small when moving them"): dragging the
  // inspector over the palette focused the inspector's move handle, and the palette yielded —
  // collapsed to its header strip. Panes overlap each other by the author's choice; stacking
  // order handles that, so focus inside ANOTHER floating pane never makes a pane yield.
  it('does not yield to focus inside another floating pane', () => {
    render(
      <div className="relative">
        <FloatingPane id="palette" title="Nodes" defaultDock="left" defaultWidth={260}>
          <p>Palette body</p>
        </FloatingPane>
        <FloatingPane id="inspector" title="Inspector" defaultDock="right" defaultWidth={320}>
          <p>Body copy</p>
        </FloatingPane>
      </div>,
    );
    const palette = screen.getByRole('region', { name: 'Nodes' });
    vi.spyOn(palette, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 260, 400));
    const handle = screen.getByRole('button', { name: 'Move Inspector' });
    vi.spyOn(handle, 'getBoundingClientRect').mockReturnValue(rect(100, 10, 24, 24));
    act(() => handle.focus());
    expect(palette.getAttribute('data-yielding')).toBe('false');
    expect(screen.getByText('Palette body')).toBeTruthy();
  });

  // 2.4.11 is about KEYBOARD focus. A mouse click on a canvas node under a pane must not collapse
  // the pane the author is working in.
  it('does not yield to focus that came from a pointer', () => {
    renderPane();
    vi.spyOn(pane(), 'getBoundingClientRect').mockReturnValue(rect(600, 0, 320, 400));
    const node = screen.getByRole('button', { name: 'Canvas node' });
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(rect(650, 100, 80, 30));
    act(() => {
      fireEvent.pointerDown(node);
      node.focus();
    });
    expect(pane().getAttribute('data-yielding')).toBe('false');
    // …and keyboard focus afterwards still yields.
    act(() => {
      node.blur();
      fireEvent.keyDown(document.body, { key: 'Tab' });
      node.focus();
    });
    expect(pane().getAttribute('data-yielding')).toBe('true');
  });

  it('does not yield to its own contents', () => {
    renderPane();
    vi.spyOn(pane(), 'getBoundingClientRect').mockReturnValue(rect(600, 0, 320, 400));
    const inside = screen.getByRole('button', { name: 'Inside the pane' });
    vi.spyOn(inside, 'getBoundingClientRect').mockReturnValue(rect(620, 100, 80, 30));
    act(() => inside.focus());
    expect(pane().getAttribute('data-yielding')).toBe('false');
  });
});
