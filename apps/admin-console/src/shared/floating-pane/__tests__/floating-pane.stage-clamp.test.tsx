/**
 * `FloatingPane` — TASK-1036 review R-C #1 / #4.
 *
 *  - A saved geometry can never strand the pane off the stage: x / y / width are CLAMPED to the
 *    stage on mount and again whenever the stage resizes, and the width is capped relative to the
 *    stage so one pane cannot swallow the canvas. The clamp is display-only — the saved preference
 *    is not rewritten, so a bigger window gets the author's own layout back.
 *  - "Reset layout" restores the pane's defaults; a double-click on the header snaps it home.
 *  - The pane reports its FOOTPRINT (how far it reaches in from the left / right edge of the stage)
 *    so the canvas can keep its controls and its fit clear of it; a collapsed or unmounted pane
 *    reports none.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { FloatingPane, floatingPaneStorageKey, type FloatingPaneFootprint } from '../floating-pane';

/** A stage of a known size (the shared setup reports 800 × 600 for every element). */
function sizeStage(stage: HTMLElement, width: number, height: number) {
  Object.defineProperty(stage, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(stage, 'clientHeight', { configurable: true, get: () => height });
}

function pane() {
  return screen.getByRole('region', { name: 'Inspector' });
}

function renderOnStage(width: number, height: number, props: Partial<React.ComponentProps<typeof FloatingPane>> = {}) {
  const stage = document.createElement('div');
  sizeStage(stage, width, height);
  document.body.appendChild(stage);
  const view = render(
    <FloatingPane id="inspector" title="Inspector" defaultDock="right" defaultWidth={320} minWidth={240} {...props}>
      <p>Body copy</p>
    </FloatingPane>,
    { container: stage },
  );
  return { ...view, stage };
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('FloatingPane — clamped to the stage (R-C #4)', () => {
  it('pulls a saved position that is off the stage back onto it, on mount', () => {
    window.localStorage.setItem(floatingPaneStorageKey('inspector'), JSON.stringify({ dock: null, x: 5000, y: 4000, width: 300, height: 300, collapsed: false }));
    renderOnStage(1000, 700);
    expect(Number(pane().getAttribute('data-x'))).toBe(1000 - 300);
    expect(Number(pane().getAttribute('data-y'))).toBeLessThanOrEqual(700 - 40);
  });

  it('caps the width relative to the stage, never below the minimum', () => {
    window.localStorage.setItem(floatingPaneStorageKey('inspector'), JSON.stringify({ dock: 'right', x: 0, y: 0, width: 2000, height: 300, collapsed: false }));
    renderOnStage(1000, 700);
    expect(Number(pane().getAttribute('data-width'))).toBe(450);
  });

  it('re-clamps when the stage shrinks, without rewriting the saved preference', () => {
    window.localStorage.setItem(floatingPaneStorageKey('inspector'), JSON.stringify({ dock: null, x: 600, y: 20, width: 300, height: 300, collapsed: false }));
    const { stage } = renderOnStage(1200, 800);
    expect(pane().getAttribute('data-x')).toBe('600');
    sizeStage(stage, 700, 800);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(Number(pane().getAttribute('data-x'))).toBe(700 - 300);
    expect(window.localStorage.getItem(floatingPaneStorageKey('inspector'))).toContain('"x":600');
  });

  it('the resize handle reports the stage-relative maximum', () => {
    renderOnStage(1000, 700);
    expect(screen.getByRole('separator', { name: 'Resize Inspector' }).getAttribute('aria-valuemax')).toBe('450');
  });
});

describe('FloatingPane — reset and snap (R-C #4)', () => {
  it('"Reset layout" restores the defaults (dock, width, expanded)', () => {
    window.localStorage.setItem(floatingPaneStorageKey('inspector'), JSON.stringify({ dock: null, x: 40, y: 40, width: 400, height: 300, collapsed: true }));
    renderOnStage(1000, 700);
    expect(pane().getAttribute('data-dock')).toBe('none');
    fireEvent.click(screen.getByRole('button', { name: 'Reset Inspector layout' }));
    expect(pane().getAttribute('data-dock')).toBe('right');
    expect(pane().getAttribute('data-width')).toBe('320');
    expect(pane().getAttribute('data-collapsed')).toBe('false');
  });

  it('a double-click on the header snaps the pane back to its edge', () => {
    renderOnStage(1000, 700);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Inspector' }), { key: 'ArrowLeft' });
    expect(pane().getAttribute('data-dock')).toBe('none');
    fireEvent.doubleClick(screen.getByRole('heading', { name: 'Inspector' }));
    expect(pane().getAttribute('data-dock')).toBe('right');
  });

  it('a double-click on a header BUTTON does not also snap', () => {
    renderOnStage(1000, 700);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Inspector' }), { key: 'ArrowLeft' });
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Collapse Inspector' }));
    expect(pane().getAttribute('data-dock')).toBe('none');
  });

  it('0 axe violations with the reset control', async () => {
    const { container } = renderOnStage(1000, 700, { onClose: vi.fn() });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('FloatingPane — reports its footprint (R-C #1)', () => {
  it('a docked pane reaches in from its edge by its width plus the dock margin', () => {
    const seen: FloatingPaneFootprint[] = [];
    renderOnStage(1000, 700, { onFootprintChange: (footprint) => seen.push(footprint) });
    expect(seen.at(-1)).toEqual({ left: 0, right: 332 });
  });

  it('a left-docked pane reaches in from the left', () => {
    const seen: FloatingPaneFootprint[] = [];
    renderOnStage(1000, 700, { defaultDock: 'left', defaultWidth: 260, onFootprintChange: (footprint) => seen.push(footprint) });
    expect(seen.at(-1)).toEqual({ left: 272, right: 0 });
  });

  it('a collapsed pane, and an unmounted one, report no footprint', () => {
    const seen: FloatingPaneFootprint[] = [];
    const { unmount } = renderOnStage(1000, 700, { onFootprintChange: (footprint) => seen.push(footprint) });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Inspector' }));
    expect(seen.at(-1)).toEqual({ left: 0, right: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Expand Inspector' }));
    expect(seen.at(-1)).toEqual({ left: 0, right: 332 });
    unmount();
    expect(seen.at(-1)).toEqual({ left: 0, right: 0 });
  });

  // TASK-1036 live check: a free pane reserves a side only while it sits against it; one dragged
  // into the middle floats above the graph and reserves nothing (the fit pushed half of it off-screen).
  it('a free pane against a side claims that side', () => {
    const seen: FloatingPaneFootprint[] = [];
    renderOnStage(1000, 700, { defaultDock: null, defaultPosition: { x: 690, y: 20 }, defaultWidth: 300, onFootprintChange: (footprint) => seen.push(footprint) });
    expect(seen.at(-1)).toEqual({ left: 0, right: 310 });
  });

  it('a free pane in the middle claims nothing', () => {
    const seen: FloatingPaneFootprint[] = [];
    renderOnStage(1000, 700, { defaultDock: null, defaultPosition: { x: 350, y: 20 }, defaultWidth: 300, onFootprintChange: (footprint) => seen.push(footprint) });
    expect(seen.at(-1)).toEqual({ left: 0, right: 0 });
  });
});
