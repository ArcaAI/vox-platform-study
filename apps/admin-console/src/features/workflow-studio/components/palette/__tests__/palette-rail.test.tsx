/**
 * `PaletteRail` — registry-driven, safety class always visible, adding a
 * node works without dragging (WCAG 2.5.7: each item is a real `<button>`).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { PaletteRail } from '../palette-rail';
import type { WorkflowNodeDescriptor } from '../../../api/types';

const NOOP: WorkflowNodeDescriptor = {
  type: 'noop',
  implemented: true,
  activityName: 'interpreter.noop',
  classes: [],
  paletteKey: null,
  critical: false,
  externalWrite: false,
  defaultTimeoutSeconds: 60,
  defaultMaxAttempts: 1,
  entitlementKey: null,
  configSchema: null,
  inputs: [],
  outputs: [],
};

const MANDATORY: WorkflowNodeDescriptor = { ...NOOP, type: 'guardrail_gate', classes: ['mandatory'], paletteKey: 'summarization' };
const GATED: WorkflowNodeDescriptor = { ...NOOP, type: 'premium_step', paletteKey: 'summarization', entitlementKey: 'feature.premium' };
const UNIMPLEMENTED: WorkflowNodeDescriptor = { ...NOOP, type: 'future_step', implemented: false, paletteKey: 'summarization' };

describe('PaletteRail', () => {
  it('renders a Skeleton row per item while loading', () => {
    const { container } = render(<PaletteRail descriptors={[]} loading onAddNode={vi.fn()} />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('shows the Empty state when the registry has no entries', () => {
    render(<PaletteRail descriptors={[]} onAddNode={vi.fn()} />);
    expect(screen.getByText(/no node types/i)).toBeTruthy();
  });

  it('every item shows its safety class as a visible badge (word, not color alone)', () => {
    render(<PaletteRail descriptors={[MANDATORY]} onAddNode={vi.fn()} />);
    expect(screen.getByText(/mandatory/i)).toBeTruthy();
  });

  it('clicking a real button inserts the node WITHOUT dragging (WCAG 2.5.7)', () => {
    const onAddNode = vi.fn();
    render(<PaletteRail descriptors={[NOOP]} onAddNode={onAddNode} />);
    const button = screen.getByRole('button', { name: /noop/i });
    button.click();
    expect(onAddNode).toHaveBeenCalledWith(NOOP);
  });

  it('an unimplemented (observable placeholder) node type renders disabled with a reason, never dropped from the list', () => {
    render(<PaletteRail descriptors={[UNIMPLEMENTED]} onAddNode={vi.fn()} />);
    const button = screen.getByRole('button', { name: /future step/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/not yet implemented/i)).toBeTruthy();
  });

  it('an entitlement-gated type the tenant lacks renders disabled with a visible reason', () => {
    render(<PaletteRail descriptors={[GATED]} entitledFeatureKeys={new Set()} onAddNode={vi.fn()} />);
    const button = screen.getByRole('button', { name: /premium step/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/not entitled/i)).toBeTruthy();
  });

  it('an entitled gated type stays enabled', () => {
    render(<PaletteRail descriptors={[GATED]} entitledFeatureKeys={new Set(['feature.premium'])} onAddNode={vi.fn()} />);
    const button = screen.getByRole('button', { name: /premium step/i });
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('groups items by palette, with a distinct group for palette-agnostic utility nodes', () => {
    render(<PaletteRail descriptors={[NOOP, MANDATORY]} onAddNode={vi.fn()} />);
    expect(screen.getByText(/summarization/i)).toBeTruthy();
    expect(screen.getByText(/utility/i)).toBeTruthy();
  });

  it('0 axe violations', async () => {
    const { container } = render(<PaletteRail descriptors={[NOOP, MANDATORY, GATED, UNIMPLEMENTED]} onAddNode={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('PaletteRail filter (UX pass)', () => {
  it('narrows the list by humanized label, announces the count, and shows an empty state', () => {
    render(<PaletteRail descriptors={[NOOP, MANDATORY]} onAddNode={vi.fn()} />);
    expect(screen.getByText('2 of 2 node types')).toBeTruthy();

    const search = screen.getByLabelText('Filter nodes');
    fireEvent.change(search, { target: { value: 'guardrail' } });
    expect(screen.getByText('1 of 2 node types')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Noop/ })).toBeNull();

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No matching node types')).toBeTruthy();
    expect(screen.getByText('0 of 2 node types')).toBeTruthy();
  });
});
