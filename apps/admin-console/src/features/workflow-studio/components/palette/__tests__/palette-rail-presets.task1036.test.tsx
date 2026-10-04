/**
 * TASK-1036 §8.4 item 7 / OD-18 — the Merge preset in the palette: a `core.data` step with a
 * ready-made pass-through config, added by click (keyboard path) or drag (the preset key rides
 * on the drag), offered only when the registry carries `core.data`.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { PaletteRail } from '../palette-rail';
import { MERGE_PRESET } from '../../../lib/palette-presets';
import { PALETTE_DRAG_MIME, PALETTE_PRESET_DRAG_MIME } from '../../../lib/palette-drag';
import type { WorkflowNodeDescriptor } from '../../../api/types';

const DATA: WorkflowNodeDescriptor = {
  type: 'core.data',
  implemented: true,
  activityName: 'interpreter.core_data',
  classes: [],
  paletteKey: 'core',
  critical: false,
  externalWrite: false,
  defaultTimeoutSeconds: 60,
  defaultMaxAttempts: 1,
  entitlementKey: null,
  configSchema: null,
  inputs: [],
  outputs: [],
};

describe('PaletteRail — presets', () => {
  it('adds the Merge preset with its config on click', () => {
    const onAddNode = vi.fn();
    render(<PaletteRail descriptors={[DATA]} onAddNode={onAddNode} />);
    fireEvent.click(screen.getByRole('button', { name: /^Merge/ }));
    expect(onAddNode).toHaveBeenCalledWith(DATA, { config: MERGE_PRESET.config, preset: MERGE_PRESET });
  });

  it('stamps the preset key on a drag', () => {
    render(<PaletteRail descriptors={[DATA]} onAddNode={vi.fn()} />);
    const data = new Map<string, string>();
    fireEvent.dragStart(screen.getByRole('button', { name: /^Merge/ }), { dataTransfer: { setData: (k: string, v: string) => data.set(k, v), effectAllowed: 'none' } });
    expect(data.get(PALETTE_DRAG_MIME)).toBe('core.data');
    expect(data.get(PALETTE_PRESET_DRAG_MIME)).toBe('merge');
  });

  it('offers no preset whose node type the registry lacks', () => {
    render(<PaletteRail descriptors={[{ ...DATA, type: 'core.note' }]} onAddNode={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Merge/ })).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<PaletteRail descriptors={[DATA]} onAddNode={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
