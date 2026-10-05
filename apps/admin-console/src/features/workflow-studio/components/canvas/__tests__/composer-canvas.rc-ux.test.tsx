/**
 * `ComposerCanvas` — TASK-1036 review R-C #1 / #2 / #9.
 *
 * The composer hands the canvas the panes' footprint (`viewportInsets`) and lays its OWN chrome
 * ("Add a step", the "Can't connect" status) inside the free band between the panes. `wheelZoom`
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

describe('ComposerCanvas — insets (R-C #1, #2)', () => {
  it('hands the panes’ footprint to the canvas', () => {
    mount({ viewportInsets: { left: 272, right: 372 } });
    expect(latest().viewportInsets).toEqual({ left: 272, right: 372 });
  });

  it('centres "Add a step" in the free band between the panes', () => {
    mount({ viewportInsets: { left: 272, right: 372 } });
    const band = screen.getByRole('button', { name: 'Add a step' }).closest('[data-slot="composer-add-step"]') as HTMLElement;
    expect(band.style.left).toBe('272px');
    expect(band.style.right).toBe('372px');
    expect(band.className).toContain('justify-center');
  });

  it('keeps the "Can’t connect" status inside the free band', () => {
    const { container } = mount({ viewportInsets: { left: 272, right: 372 } });
    const band = container.querySelector('[data-slot="composer-announcement"]') as HTMLElement;
    expect(band.style.left).toBe('272px');
    expect(band.style.right).toBe('372px');
    act(() => {
      latest().isValidConnection({ source: 'nope', target: 'also-nope' });
    });
    expect(band.querySelector('[role="status"]')?.textContent).toMatch(/^Can’t connect/);
  });

  it('with no panes, the band is the whole canvas width', () => {
    mount();
    const band = screen.getByRole('button', { name: 'Add a step' }).closest('[data-slot="composer-add-step"]') as HTMLElement;
    expect(band.style.left).toBe('0px');
    expect(band.style.right).toBe('0px');
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
