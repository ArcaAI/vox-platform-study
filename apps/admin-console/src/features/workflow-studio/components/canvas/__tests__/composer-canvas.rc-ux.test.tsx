/**
 * `ComposerCanvas` — TASK-1036 review R-C #1 / #2 / #9.
 *
 * The composer hands the canvas the panes' footprint (`viewportInsets`) for its FIT only; its own
 * chrome ("Add a step", the "Can't connect" status) is anchored to the canvas and never moves with
 * a pane (owner, 2026-10-05). `wheelZoom`
 * passes through; a read-only canvas given none (the Test tab's Flow) is left to the canvas's
 * default (`modifier`: the wheel scrolls the page, Ctrl/⌘+wheel zooms).
 *
 * The `@arcaai/ui` canvas is replaced with a prop recorder — what is under test is what the
 * composer HANDS it (the canvas has its own suite in `packages/ui`).
 */
import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { GraphStoreProvider } from '../../../store';
import { REGISTRY } from '../../../lib/__tests__/registry-fixture';
import { ComposerCanvas, type ComposerCanvasProps } from '../composer-canvas';

const captured: Array<Record<string, unknown>> = [];
vi.mock('@arcaai/ui/components/workflow-canvas', () => ({
  WorkflowCanvas: (props: Record<string, unknown>) => {
    captured.push(props);
    return <div data-testid="canvas" />;
  },
}));
vi.mock('../../../api/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/hooks')>();
  return { ...actual, useAgentOptions: () => ({ data: [] }) };
});

const latest = () => captured.at(-1) as Record<string, unknown> & { isValidConnection: (c: Record<string, unknown>) => boolean };

function mount(props: Partial<ComposerCanvasProps> = {}) {
  return renderWithProviders(
    <GraphStoreProvider>
      <ComposerCanvas aria-label="graph" descriptorByType={REGISTRY} {...props} />
    </GraphStoreProvider>,
  );
}

beforeEach(() => {
  captured.length = 0;
});

describe('ComposerCanvas — insets shape the fit only; the chrome is anchored (R-C #1, #2)', () => {
  it('hands the panes’ footprint to the canvas (for its fit)', () => {
    mount({ viewportInsets: { left: 272, right: 372 } });
    expect(latest().viewportInsets).toEqual({ left: 272, right: 372 });
  });

  it('anchors "Add a step" to the canvas top centre — a pane’s footprint never moves it', () => {
    const { unmount } = mount();
    const bandOf = () => screen.getByRole('button', { name: 'Add a step' }).closest('[data-slot="composer-add-step"]') as HTMLElement;
    const before = { className: bandOf().className, style: bandOf().getAttribute('style') };
    unmount();
    mount({ viewportInsets: { left: 272, right: 372 } });
    expect({ className: bandOf().className, style: bandOf().getAttribute('style') }).toEqual(before);
    expect(bandOf().className).toContain('inset-x-0');
    expect(bandOf().className).toContain('justify-center');
  });

  it('anchors the "Can’t connect" status the same way, whatever the panes do', () => {
    const { container } = mount({ viewportInsets: { left: 272, right: 372 } });
    const band = container.querySelector('[data-slot="composer-announcement"]') as HTMLElement;
    expect(band.getAttribute('style')).toBeNull();
    expect(band.className).toContain('inset-x-0');
    act(() => {
      latest().isValidConnection({ source: 'nope', target: 'also-nope' });
    });
    expect(band.querySelector('[role="status"]')?.textContent).toMatch(/^Can’t connect/);
  });
});

describe('ComposerCanvas — wheel zoom (R-C #9)', () => {
  it('passes `wheelZoom` through when the caller sets it', () => {
    mount({ readOnly: true, wheelZoom: 'scroll' });
    expect(latest().wheelZoom).toBe('scroll');
  });

  it('leaves a read-only canvas with none to the canvas default (modifier)', () => {
    mount({ readOnly: true });
    expect('wheelZoom' in latest()).toBe(false);
    expect(latest().readOnly).toBe(true);
  });

  it('0 axe violations', async () => {
    const { container } = mount({ viewportInsets: { left: 100, right: 100 } });
    expect(await axe(container)).toHaveNoViolations();
  });
});
