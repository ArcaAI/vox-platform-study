import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useAgentOptions = vi.fn();
vi.mock('../../../api/hooks', () => ({ useAgentOptions: (...args: unknown[]) => useAgentOptions(...args) }));

import { AgentPickerField } from '../agent-picker-field';

describe('AgentPickerField', () => {
  beforeEach(() => useAgentOptions.mockReset());

  it('lists published agents of the task and reports the chosen slug', () => {
    useAgentOptions.mockReturnValue({ isPending: false, isError: false, data: [{ slug: 'platform-summarization', name: 'Summarization', task: 'TEXT_GENERATION' }] });
    const onChange = vi.fn();
    render(<AgentPickerField id="agent" value="platform-summarization" onChange={onChange} />);
    expect(useAgentOptions).toHaveBeenCalledWith('TEXT_GENERATION');
    expect(screen.getByRole('combobox', { name: /agent/i })).toBeTruthy();
    expect(screen.getByText(/create agent/i).closest('a')?.getAttribute('href')).toBe('/agents?create=1');
  });

  it('falls back to a slug box when the agent surface is unavailable, keeping the value editable', () => {
    useAgentOptions.mockReturnValue({ isPending: false, isError: true, data: undefined });
    const onChange = vi.fn();
    render(<AgentPickerField id="agent" value="" onChange={onChange} />);
    const box = screen.getByLabelText(/agent slug/i);
    fireEvent.change(box, { target: { value: 'my-agent' } });
    expect(onChange).toHaveBeenCalledWith('my-agent');
    expect(screen.getByText(/unavailable/i)).toBeTruthy();
  });

  it('shows a skeleton while loading', () => {
    useAgentOptions.mockReturnValue({ isPending: true, isError: false, data: undefined });
    const { container } = render(<AgentPickerField id="agent" value="" onChange={vi.fn()} />);
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });
});
