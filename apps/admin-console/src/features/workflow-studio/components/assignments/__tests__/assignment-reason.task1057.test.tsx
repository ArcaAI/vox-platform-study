/** TASK-1057 — the workflow assignment drawer reads `workflowAssignment.set` and sends `reason`. */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { AssignmentEditDrawer } from '../assignment-edit-drawer';
import type { WorkflowAssignment } from '../../../api/types';

const mocks = vi.hoisted(() => ({ rows: [] as unknown[], update: vi.fn() }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api')>()),
  getJson: vi.fn(async () => ({ items: mocks.rows })),
}));
vi.mock('../../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api')>()),
  useCreateWorkflowAssignment: () => ({ mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
  useUpdateWorkflowAssignment: () => ({ mutate: mocks.update, isPending: false, error: null, reset: vi.fn() }),
  useDeleteWorkflowAssignment: () => ({ mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
}));

const row = (mode: 'required' | 'not-required') => ({ actionId: 'workflowAssignment.set', kind: 'reason', mode, locked: false });
const existing = { id: 'wa-1', workflowDefinitionSlug: 'soap-a', version: 3 } as unknown as WorkflowAssignment;

function renderDrawer() {
  renderWithProviders(
    <AssignmentEditDrawer
      open
      onOpenChange={vi.fn()}
      scope="TENANT"
      scopeId={null}
      scopeLabel="Tenant default"
      paletteKey="SOAP"
      paletteLabel="SOAP"
      existing={existing}
      resolvedSlug="soap-a"
      resolvedSource="explicit"
      definitionOptions={[{ slug: 'soap-a', name: 'A' }, { slug: 'soap-b', name: 'B' }]}
      onReloadLatest={vi.fn()}
    />,
  );
}

async function pickDefinition(name: string) {
  const trigger = await screen.findByRole('combobox', { name: 'Workflow definition' });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name }));
}

beforeEach(() => mocks.update.mockReset());
afterEach(cleanup);

describe('AssignmentEditDrawer — workflowAssignment.set policy', () => {
  it('required: Save waits for a reason and sends it', async () => {
    mocks.rows = [row('required')];
    renderDrawer();
    await screen.findByText('Required. Recorded in the audit log.');
    await pickDefinition('B (soap-b)');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'palette change' } });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    expect(mocks.update.mock.calls[0][0].body.reason).toBe('palette change');
  });

  it('not required: Save works without a reason', async () => {
    mocks.rows = [row('not-required')];
    renderDrawer();
    await screen.findByText('Recorded in the audit log when given.');
    await pickDefinition('B (soap-b)');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.update.mock.calls[0][0].body.reason).toBeUndefined();
  });
});
