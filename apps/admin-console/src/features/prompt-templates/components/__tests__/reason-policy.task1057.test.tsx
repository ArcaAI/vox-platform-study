/**
 * TASK-1057 — prompt template create / update / approve read their reason policy from the platform
 * (`admin/settings/action-confirmations/effective`): required → the submit stays disabled until a
 * reason is typed and the reason travels; not-required → it submits without one.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { setTemplateEditorValue } from '@/test/template-editor';
import { CreateTemplateForm, EditTemplateForm } from '../template-form-dialog';
import type { PromptTemplate } from '../../api/types';

const mocks = vi.hoisted(() => ({ rows: [] as unknown[], update: vi.fn(), create: vi.fn() }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api')>()),
  getJson: vi.fn(async () => ({ items: mocks.rows })),
}));
vi.mock('../../api/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/hooks')>()),
  useUpdateTemplate: () => ({ mutate: mocks.update, isPending: false, error: null, reset: vi.fn() }),
  useCreateTemplate: () => ({ mutate: mocks.create, isPending: false, error: null, reset: vi.fn() }),
  useDepartments: () => ({ data: [] }),
}));

const row = (actionId: string, mode: 'required' | 'not-required') => ({ actionId, kind: 'reason', mode, locked: false });

function template(): PromptTemplate {
  return {
    id: 'pt-1',
    name: 'Cardiology Notes',
    content: 'You are a clinical scribe.',
    category: 'SUMMARY',
    status: 'DRAFT',
    currentVersionNumber: 2,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    version: 2,
  };
}

beforeEach(() => {
  mocks.update.mockReset();
  mocks.create.mockReset();
});
afterEach(cleanup);

describe('EditTemplateForm — promptTemplate.update policy', () => {
  function edit() {
    renderWithProviders(<EditTemplateForm template={template()} etag={'"2"'} onSaved={vi.fn()} onReload={vi.fn()} />);
    setTemplateEditorValue(screen.getByRole('textbox', { name: 'Prompt content' }), 'You are a cardiology scribe.');
  }
  const save = () => screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement;

  it('required: Save waits for a reason and sends it as changeReason', async () => {
    mocks.rows = [row('promptTemplate.update', 'required')];
    edit();
    await screen.findByText('Required. Recorded in the audit log.');
    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Change reason/), { target: { value: 'tighten wording' } });
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    expect(mocks.update.mock.calls[0][0].patch.changeReason).toBe('tighten wording');
  });

  it('not required: Save works without a reason', async () => {
    mocks.rows = [row('promptTemplate.update', 'not-required')];
    edit();
    await screen.findByText('Recorded in the audit log when given.');
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    expect(mocks.update.mock.calls[0][0].patch.changeReason).toBeUndefined();
  });
});

describe('CreateTemplateForm — promptTemplate.create policy', () => {
  function fill() {
    renderWithProviders(<CreateTemplateForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(document.getElementById('create-template-name')!, { target: { value: 'New' } });
    setTemplateEditorValue(screen.getByRole('textbox', { name: 'Prompt content' }), 'Hello');
  }
  const create = () => screen.getByRole('button', { name: /create prompt/i }) as HTMLButtonElement;

  it('required: Create waits for a reason and sends it', async () => {
    mocks.rows = [row('promptTemplate.create', 'required')];
    fill();
    await screen.findByText('Required. Recorded in the audit log.');
    expect(create().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Change reason/), { target: { value: 'first draft' } });
    await waitFor(() => expect(create().disabled).toBe(false));
    fireEvent.click(create());
    expect(mocks.create.mock.calls[0][0].changeReason).toBe('first draft');
  });

  it('not required: Create works without a reason', async () => {
    mocks.rows = [row('promptTemplate.create', 'not-required')];
    fill();
    await screen.findByText('Recorded in the audit log when given.');
    fireEvent.click(create());
    expect(mocks.create.mock.calls[0][0].changeReason).toBeUndefined();
  });
});
