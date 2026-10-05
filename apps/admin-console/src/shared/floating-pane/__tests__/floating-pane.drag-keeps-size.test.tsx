/**
 * `FloatingPane` — TASK-1036 owner complaint (2026-10-05): "the node-palette-pane and
 * Node-inspector-pane are resized to small when moving them".
 *
 * A drag changes the pane's POSITION only. Its size changes only through the resize handle (or
 * Shift+Arrow), or when the stage genuinely cannot fit it — and then the remembered size comes back
 * when the room does.
 *
 * `data-width` / `data-height` are the size the pane is DRAWN at: a docked pane spans the stage
 * top-to-bottom (less the dock margin), so that is its height until something resizes it.
 * jsdom has no layout, so the stage's size is stubbed (`clientWidth` / `clientHeight`).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FloatingPane, floatingPaneStorageKey } from '../floating-pane';

const STAGE = { width: 1000, height: 700 };
/** A docked pane is drawn `md:top-3 … md:bottom-3`: the stage height less 2 × 12px. */
const DOCKED_HEIGHT = STAGE.height - 24;

function sizeStage(stage: HTMLElement, width: number, height: number) {
  Object.defineProperty(stage, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(stage, 'clientHeight', { configurable: true, get: () => height });
}

function pane() {
  return screen.getByRole('region', { name: 'Inspector' });
}
function grip() {
  return screen.getByRole('button', { name: 'Move Inspector' });
}
function size() {
  return { width: pane().getAttribute('data-width'), height: pane().getAttribute('data-height') };
}

function renderOnStage(props: Partial<React.ComponentProps<typeof FloatingPane>> = {}) {
  const stage = document.createElement('div');
  sizeStage(stage, STAGE.width, STAGE.height);
  document.body.appendChild(stage);
  const view = render(
    <FloatingPane id="inspector" title="Inspector" defaultDock="right" defaultWidth={360} minWidth={240} {...props}>
      <p>Body copy</p>
    </FloatingPane>,
    { container: stage },
  );
  return { ...view, stage };
}

function pointerDrag(dx: number, dy: number) {
  const mouse = (type: string, clientX: number, clientY: number) => new MouseEvent(type, { bubbles: true, clientX, clientY });
  act(() => {
    grip().dispatchEvent(mouse('pointerdown', 500, 30));
    window.dispatchEvent(mouse('pointermove', 500 + dx / 2, 30 + dy / 2));
    window.dispatchEvent(mouse('pointermove', 500 + dx, 30 + dy));
    window.dispatchEvent(mouse('pointerup', 500 + dx, 30 + dy));
  });
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('FloatingPane — a drag moves the pane and never resizes it', () => {
  it('a docked pane reports the size it is drawn at (full stage height less the dock margin)', () => {
    renderOnStage();
    expect(size()).toEqual({ width: '360', height: String(DOCKED_HEIGHT) });
  });

  it('pointer-dragging the docked inspector out keeps its width AND its height', () => {
    renderOnStage();
    const before = size();
    pointerDrag(-300, 0);
    expect(pane().getAttribute('data-dock')).toBe('none');
    expect(size()).toEqual(before);
    expect(pane().style.getPropertyValue('--fp-h')).toBe(`${DOCKED_HEIGHT}px`);
    expect(pane().style.getPropertyValue('--fp-w')).toBe('360px');
  });

  it('pointer-dragging the docked palette (left dock) out keeps its size', () => {
    renderOnStage({ defaultDock: 'left', defaultWidth: 260, minWidth: 200 });
    const before = size();
    pointerDrag(200, 0);
    expect(pane().getAttribute('data-dock')).toBe('none');
    expect(size()).toEqual(before);
  });

  it('dragging a free pane toward the bottom stops it at the edge instead of squashing it', () => {
    renderOnStage({ defaultDock: null, defaultPosition: { x: 40, y: 40 }, defaultWidth: 300, defaultHeight: 300 });
    pointerDrag(0, 600);
    expect(size()).toEqual({ width: '300', height: '300' });
    expect(Number(pane().getAttribute('data-y'))).toBe(STAGE.height - 300);
  });

  it('dragging a free pane toward the right edge stops it there instead of narrowing it', () => {
    renderOnStage({ defaultDock: null, defaultPosition: { x: 40, y: 40 }, defaultWidth: 300, defaultHeight: 300 });
    pointerDrag(2000, 0);
    expect(size()).toEqual({ width: '300', height: '300' });
    expect(Number(pane().getAttribute('data-x'))).toBe(STAGE.width - 300);
  });

  it('keyboard move (arrow keys on the grip) of a docked pane keeps its size', () => {
    renderOnStage();
    const before = size();
    fireEvent.keyDown(grip(), { key: 'ArrowLeft' });
    expect(pane().getAttribute('data-dock')).toBe('none');
    expect(size()).toEqual(before);
    for (let i = 0; i < 60; i += 1) fireEvent.keyDown(grip(), { key: 'ArrowDown' });
    expect(size()).toEqual(before);
  });

  it('the size a drag kept is the size that is saved and restored', () => {
    const { unmount } = renderOnStage();
    pointerDrag(-300, 40);
    const moved = size();
    unmount();
    document.body.innerHTML = '';
    renderOnStage();
    expect(size()).toEqual(moved);
    expect(window.localStorage.getItem(floatingPaneStorageKey('inspector'))).toContain(`"height":${DOCKED_HEIGHT}`);
  });

  it('a stage too short for the pane shrinks it for display only, and the size comes back with the room', () => {
    window.localStorage.setItem(floatingPaneStorageKey('inspector'), JSON.stringify({ dock: null, x: 40, y: 40, width: 300, height: 500, collapsed: false }));
    const { stage } = renderOnStage();
    expect(size()).toEqual({ width: '300', height: '500' });
    sizeStage(stage, STAGE.width, 400);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(size()).toEqual({ width: '300', height: '400' });
    sizeStage(stage, STAGE.width, STAGE.height);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(size()).toEqual({ width: '300', height: '500' });
  });

  it('the resize handle still resizes (size changes only through it)', () => {
    renderOnStage({ defaultDock: null, defaultPosition: { x: 40, y: 40 }, defaultWidth: 300, defaultHeight: 300 });
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Inspector' }), { key: 'ArrowRight' });
    expect(size()).toEqual({ width: '316', height: '300' });
  });
});
