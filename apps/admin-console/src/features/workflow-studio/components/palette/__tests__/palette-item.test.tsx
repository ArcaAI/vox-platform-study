/**
 * `PaletteItem` (TASK-893 B1/§4.4) — the card shape and the one-line purpose. Behavior shared
 * with the pre-existing `<Button>` (disabled/entitled/draggable/keyboard-add) stays covered by
 * `palette-rail.test.tsx`; this file covers only what changed here.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaletteItem } from '../palette-item';
import type { WorkflowNodeDescriptor } from '../../../api/types';

const BASE: WorkflowNodeDescriptor = {
  type: 'core.agent',
  implemented: true,
  activityName: 'interpreter.core_agent',
  classes: [],
  paletteKey: 'core',
  critical: false,
  externalWrite: false,
  defaultTimeoutSeconds: 60,
  defaultMaxAttempts: 1,
  entitlementKey: null,
  configSchema: { summary: 'Runs one published agent to do a task.' },
  inputs: [],
  outputs: [],
};

describe('PaletteItem', () => {
  it('renders a real card — rounded-md, never the pill radius', () => {
    render(<PaletteItem descriptor={BASE} entitled onAdd={vi.fn()} />);
    const button = screen.getByRole('button', { name: /agent/i });
    expect(button.className).toContain('rounded-md');
    expect(button.className).not.toContain('rounded-control');
    expect(button.className).not.toContain('rounded-full');
  });

  it('stays a semantic <button>, still keyboard-operable (WCAG 2.5.7)', () => {
    render(<PaletteItem descriptor={BASE} entitled onAdd={vi.fn()} />);
    expect(screen.getByRole('button', { name: /agent/i }).tagName).toBe('BUTTON');
  });

  it('shows the one-line purpose from the config schema summary', () => {
    render(<PaletteItem descriptor={BASE} entitled onAdd={vi.fn()} />);
    expect(screen.getByText('Runs one published agent to do a task.')).toBeTruthy();
  });

  it('renders with no purpose line and does not crash when configSchema is null', () => {
    const withoutSchema: WorkflowNodeDescriptor = { ...BASE, configSchema: null };
    render(<PaletteItem descriptor={withoutSchema} entitled onAdd={vi.fn()} />);
    expect(screen.getByRole('button', { name: /agent/i })).toBeTruthy();
  });

  it('renders with no purpose line when the schema carries no summary', () => {
    const noSummary: WorkflowNodeDescriptor = { ...BASE, configSchema: { title: 'core.agent node config' } };
    render(<PaletteItem descriptor={noSummary} entitled onAdd={vi.fn()} />);
    expect(screen.queryByText(/task/i)).toBeNull();
  });
});
