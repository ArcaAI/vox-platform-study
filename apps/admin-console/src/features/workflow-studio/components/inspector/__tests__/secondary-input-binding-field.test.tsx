/**
 * `SecondaryInputBindingField` (TASK-893 B5) — a secondary DATA input rendered as a labelled
 * picker over upstream nodes instead of a canvas wire.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SecondaryInputBindingField, type UpstreamNodeOption } from '../secondary-input-binding-field';

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => cleanup());

async function openSelect(label: string | RegExp) {
  const trigger = await screen.findByLabelText(label);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  return screen.findByRole('listbox');
}

const UPSTREAM: UpstreamNodeOption[] = [
  { id: 'trigger-1', label: 'Trigger', step: 1 },
  { id: 'agent-1', label: 'Extract entities', step: 2 },
];

describe('SecondaryInputBindingField', () => {
  it('labels the field from the port name', () => {
    render(<SecondaryInputBindingField id="f1" portName="context" primitive="text" required={false} upstreamNodes={UPSTREAM} value={null} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/^Context/)).toBeTruthy();
  });

  it('marks a required binding with a visible *', () => {
    render(<SecondaryInputBindingField id="f1" portName="context" primitive="text" required upstreamNodes={UPSTREAM} value={null} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/^Context \*/)).toBeTruthy();
  });

  it('lists upstream nodes in execution order, each with its step number', async () => {
    render(<SecondaryInputBindingField id="f1" portName="context" primitive="text" required={false} upstreamNodes={UPSTREAM} value={null} onChange={vi.fn()} />);
    const listbox = await openSelect(/^Context/);
    expect(within(listbox).getByRole('option', { name: '1. Trigger' })).toBeTruthy();
    expect(within(listbox).getByRole('option', { name: '2. Extract entities' })).toBeTruthy();
    expect(within(listbox).getByRole('option', { name: 'None' })).toBeTruthy();
  });

  it('choosing an upstream node reports its id', async () => {
    const onChange = vi.fn();
    render(<SecondaryInputBindingField id="f1" portName="context" primitive="text" required={false} upstreamNodes={UPSTREAM} value={null} onChange={onChange} />);
    const listbox = await openSelect(/^Context/);
    fireEvent.click(within(listbox).getByRole('option', { name: '2. Extract entities' }));
    expect(onChange).toHaveBeenCalledWith('agent-1');
  });

  it('choosing None clears an existing binding', async () => {
    const onChange = vi.fn();
    render(<SecondaryInputBindingField id="f1" portName="context" primitive="text" required={false} upstreamNodes={UPSTREAM} value="trigger-1" onChange={onChange} />);
    const listbox = await openSelect(/^Context/);
    fireEvent.click(within(listbox).getByRole('option', { name: 'None' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('a value no longer upstream degrades to None rather than crashing', () => {
    render(<SecondaryInputBindingField id="f1" portName="context" primitive="text" required={false} upstreamNodes={UPSTREAM} value="deleted-node" onChange={vi.fn()} />);
    expect(screen.getByText(/not upstream anymore/i)).toBeTruthy();
  });

  it('renders a validation error when given one', () => {
    render(
      <SecondaryInputBindingField
        id="f1"
        portName="context"
        primitive="text"
        required
        upstreamNodes={UPSTREAM}
        value={null}
        onChange={vi.fn()}
        errors={['context is required']}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('context is required');
  });
});
