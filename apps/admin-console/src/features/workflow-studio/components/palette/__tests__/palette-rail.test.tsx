/**
 * `PaletteRail` — registry-driven, safety class always visible, adding a
 * node works without dragging (WCAG 2.5.7: each item is a real `<button>`).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { PaletteRail } from '../palette-rail';
import { humanizeKey } from '../../../lib/schema-form';
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

/**
 * TASK-893 — an ACTION_CATALOGUE entry, served in the same payload so `effectiveNodePorts` can
 * resolve a `core.action` instance's sockets. It is not a node type and must never be offered.
 */
const ACTION: WorkflowNodeDescriptor = { ...NOOP, type: 'guard.phi', kind: 'action', paletteKey: 'core' };

describe('PaletteRail', () => {
  it('never offers an ACTION as a node type — a graph node typed on an action key does not compile', () => {
    const onAddNode = vi.fn();
    render(<PaletteRail descriptors={[NOOP, ACTION]} onAddNode={onAddNode} />);

    expect(screen.queryByRole('button', { name: /guard\.phi|Guard Phi/i })).toBeNull();
    expect(screen.getByRole('button', { name: /noop/i })).toBeTruthy();
  });

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

  /**
   * TASK-890 black-box J4-F1 — the item's own doc promised a drag the code never implemented.
   * The drag is an ENHANCEMENT: the click path above still adds the node, and a disabled item
   * (unimplemented / unentitled) is not draggable either, so the two paths refuse in step.
   */
  it('a palette item is draggable and carries its registry type on the drag', () => {
    render(<PaletteRail descriptors={[NOOP]} onAddNode={vi.fn()} />);
    const button = screen.getByRole('button', { name: /noop/i });
    expect(button.getAttribute('draggable')).toBe('true');

    const store = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: 'none',
      setData: (format: string, value: string) => void store.set(format, value),
      getData: (format: string) => store.get(format) ?? '',
    };
    fireEvent.dragStart(button, { dataTransfer });
    expect(store.get('application/x-hope-workflow-node')).toBe('noop');
  });

  it('a disabled palette item is not draggable either', () => {
    render(<PaletteRail descriptors={[UNIMPLEMENTED]} onAddNode={vi.fn()} />);
    expect(screen.getByRole('button', { name: /future step/i }).getAttribute('draggable')).toBe('false');
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

  it('TASK-893: the rail hides nothing — every registered type is offered — and the core group comes first', () => {
    const CORE: WorkflowNodeDescriptor = { ...NOOP, type: 'core.agent', paletteKey: 'core', classes: ['agent'] };
    render(<PaletteRail descriptors={[MANDATORY, CORE]} onAddNode={vi.fn()} />);
    expect(screen.getByRole('button', { name: new RegExp(humanizeKey('core.agent'), 'i') })).toBeTruthy();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings[0]).toMatch(/core/i);
    expect(screen.getByText(/2 of 2 node types/i)).toBeTruthy();
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
