/**
 * TASK-1036 OD-12 / D-7 — inline agent create / edit from the Studio's `core.agent` picker.
 *
 * Create binds the node to the new agent's slug AND version (W3 pins); Edit publishes a NEW
 * version and re-pins THIS node only; a draft kept back by an unapproved prompt binds nothing and
 * stays open with its reason. The wizard itself is covered in `shared/agent-wizard`; here it is a
 * stub that reports each outcome.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { workflowStudioKeys } from '../../../api/keys';

const useAgentOptions = vi.fn();
vi.mock('../../../api/hooks', () => ({ useAgentOptions: (...args: unknown[]) => useAgentOptions(...args) }));

interface StubProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agent: { slug: string; versionNumber: number }, result: { published: boolean; blocked: boolean; findings: unknown[] }) => void;
  edit?: { slug: string; versionNumber?: number | null };
}
vi.mock('@/shared/agent-wizard/agent-wizard', () => ({
  AgentWizard: (props: StubProps) =>
    props.open ? (
      <div role="dialog" aria-label="Agent wizard stub">
        <p>{props.edit ? `editing ${props.edit.slug} from v${props.edit.versionNumber}` : 'creating'}</p>
        <button type="button" onClick={() => props.onCreated({ slug: props.edit?.slug ?? 'new-agent', versionNumber: props.edit ? 5 : 1 }, { published: true, blocked: false, findings: [] })}>
          stub-published
        </button>
        <button type="button" onClick={() => props.onCreated({ slug: props.edit?.slug ?? 'new-agent', versionNumber: 2 }, { published: false, blocked: true, findings: [{ code: 'AGENT_PROMPT_NOT_APPROVED' }] })}>
          stub-blocked
        </button>
        <button type="button" onClick={() => props.onOpenChange(false)}>
          stub-close
        </button>
      </div>
    ) : null,
}));

import { AgentPickerField } from '../agent-picker-field';

const AGENTS = [
  { slug: 'clinic-summary', name: 'Clinic summary', task: 'TEXT_GENERATION', versionNumber: 4 },
  { slug: 'medical-ner', name: 'Medical NER', task: 'NAMED_ENTITY_RECOGNITION', versionNumber: 1 },
];

beforeEach(() => {
  useAgentOptions.mockReset();
  useAgentOptions.mockReturnValue({ isPending: false, isError: false, data: AGENTS });
});
afterEach(cleanup);

describe('AgentPickerField — inline create / edit', () => {
  it('Create agent opens the wizard; a published agent binds slug and version and closes it, and the options refresh', async () => {
    const onChange = vi.fn();
    const { queryClient } = renderWithProviders(<AgentPickerField id="agent" value="" onChange={onChange} />);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(await screen.findByText('creating')).toBeTruthy();
    fireEvent.click(screen.getByText('stub-published'));
    expect(onChange).toHaveBeenCalledWith('new-agent', 1);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Agent wizard stub' })).toBeNull());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: workflowStudioKeys.agentOptions() });
  });

  it('a draft kept back by an unapproved prompt binds nothing and the wizard stays open', async () => {
    const onChange = vi.fn();
    renderWithProviders(<AgentPickerField id="agent" value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    fireEvent.click(await screen.findByText('stub-blocked'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Agent wizard stub' })).toBeTruthy();
  });

  it('Edit agent is offered only for an agent in the list, opens from the pinned version, and re-pins THIS node to the new one', async () => {
    const onChange = vi.fn();
    renderWithProviders(<AgentPickerField id="agent" value="clinic-summary" versionNumber={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit agent' }));
    expect(await screen.findByText('editing clinic-summary from v3')).toBeTruthy();
    fireEvent.click(screen.getByText('stub-published'));
    expect(onChange).toHaveBeenCalledWith('clinic-summary', 5);
  });

  it('offers no Edit for an empty or unknown slug', () => {
    const { rerender } = renderWithProviders(<AgentPickerField id="agent" value="" onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Edit agent' })).toBeNull();
    rerender(<AgentPickerField id="agent" value="ghost" onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Edit agent' })).toBeNull();
  });

  it('choosing an existing agent passes its current version along, so the node can pin it', async () => {
    const onChange = vi.fn();
    renderWithProviders(<AgentPickerField id="agent" value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: /agent/i }));
    fireEvent.click(await screen.findByRole('option', { name: /Clinic summary/ }));
    expect(onChange).toHaveBeenCalledWith('clinic-summary', 4);
  });

  it('is disabled with the node: no create or edit while read-only', () => {
    renderWithProviders(<AgentPickerField id="agent" value="clinic-summary" onChange={vi.fn()} disabled />);
    expect((screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Edit agent' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
