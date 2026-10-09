/** TASK-1057 — the governance approve panel reads `promptTemplate.approve` and sends `reason`. */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ApprovePanel } from '../governance-tab';
import type { PromptTemplate } from '../../api/types';

const mocks = vi.hoisted(() => ({ rows: [] as unknown[], approve: vi.fn() }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api')>()),
  getJson: vi.fn(async () => ({ items: mocks.rows })),
}));
vi.mock('@/shared/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/auth')>()),
  useSession: () => ({ data: { isElevated: true } }),
  usePermissions: () => ({ data: [] }),
}));
vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  useApproveTemplate: () => ({ mutate: mocks.approve, isPending: false, error: null, reset: vi.fn() }),
}));

const row = (mode: 'required' | 'not-required') => ({ actionId: 'promptTemplate.approve', kind: 'reason', mode, locked: false });
const template = { id: 'pt-1', name: 'Cardiology Notes', tenantId: 't-1', status: 'PUBLISHED' } as unknown as PromptTemplate;
const button = () => screen.getByRole('button', { name: /approve for clinical use/i }) as HTMLButtonElement;

beforeEach(() => mocks.approve.mockReset());
afterEach(cleanup);

describe('ApprovePanel — promptTemplate.approve policy', () => {
  it('required: waits for a reason and sends it', async () => {
    mocks.rows = [row('required')];
    renderWithProviders(<ApprovePanel template={template} etag={'"5"'} />);
    await screen.findByText('Required. Recorded in the audit log.');
    expect(button().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Approval reason/), { target: { value: 'eval passed' } });
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    expect(mocks.approve.mock.calls[0][0]).toMatchObject({ id: 'pt-1', reason: 'eval passed' });
  });

  it('not required: approves without a reason', async () => {
    mocks.rows = [row('not-required')];
    renderWithProviders(<ApprovePanel template={template} etag={'"5"'} />);
    await screen.findByText('Recorded in the audit log when given.');
    fireEvent.click(button());
    expect(mocks.approve.mock.calls[0][0].reason).toBeUndefined();
  });
});
