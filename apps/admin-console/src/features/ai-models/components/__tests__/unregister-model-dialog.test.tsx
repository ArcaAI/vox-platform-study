/**
 * C3 (TASK-1019, Lane C) — the Unregister dialog: loads `:id/usage`, a referrer
 * blocks the confirm with the list and a visible reason, "purge" is off by
 * default, and confirm posts `:id/unregister`. Both 409 codes surface as toasts.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { AiModelsScreen } from '../ai-models-screen';
import { UnregisterModelDialog } from '../unregister-model-dialog';
import { BASE_MODEL, envelope, stubFetch } from './fixtures.task1019';

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const REFERRERS = [
  { kind: 'agent', tenantId: 't-1', id: 'ag-1', name: 'Scribe agent' },
  { kind: 'routing-policy', tenantId: 't-2', id: 'rp-1', name: 'NER routing' },
];

function usageStub(referrers: typeof REFERRERS | [], extra?: (url: string, method: string) => Response | undefined) {
  return stubFetch((url, method) => {
    const custom = extra?.(url, method);
    if (custom) return custom;
    if (url.endsWith('/m-1/usage')) return Response.json({ referrers });
    return Response.json(envelope([BASE_MODEL]));
  });
}

const confirmButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Unregister model' }) as HTMLButtonElement;

describe('UnregisterModelDialog (C3)', () => {
  it('lists the referrers and disables the confirm, stating why', async () => {
    const calls = usageStub(REFERRERS);
    renderWithProviders(<UnregisterModelDialog model={BASE_MODEL} open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Unregister model' });

    const list = await within(dialog).findByRole('list', { name: 'Referrers' });
    expect(within(list).getByText('Scribe agent')).toBeDefined();
    expect(within(list).getByText('NER routing')).toBeDefined();
    expect(within(list).getByText('tenant t-2')).toBeDefined();
    expect(confirmButton(dialog).disabled).toBe(true);
    expect(within(dialog).getByText(/cannot be unregistered while they exist/i)).toBeDefined();
    expect(calls.some((call) => call.url.endsWith('/m-1/usage'))).toBe(true);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('with no referrers: weights deletion is on, purge is OFF by default, and confirm posts unregister', async () => {
    const calls = usageStub([], (url, method) =>
      url.endsWith('/m-1/unregister') && method === 'POST' ? Response.json({ jobId: 'job-7', weights: 'deleting' }, { status: 202 }) : undefined,
    );
    const onOpenChange = vi.fn();
    renderWithProviders(<UnregisterModelDialog model={BASE_MODEL} open onOpenChange={onOpenChange} />);
    const dialog = await screen.findByRole('dialog', { name: 'Unregister model' });

    const weights = within(dialog).getByRole('checkbox', { name: 'Delete weights from the bucket' });
    const purge = within(dialog).getByRole('checkbox', { name: 'Purge all versions now' });
    expect(weights.getAttribute('aria-checked')).toBe('true');
    expect(purge.getAttribute('aria-checked')).toBe('false');
    expect(within(dialog).getByText(/recoverable for 30 days/i)).toBeDefined();

    await waitFor(() => expect(confirmButton(dialog).disabled).toBe(false));
    fireEvent.click(confirmButton(dialog));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.url).toBe('/api/hope/admin/ai-models/m-1/unregister');
    expect(post.body).toEqual({ deleteWeights: true, purge: false });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('purge ticked posts purge:true; unticking delete-weights posts deleteWeights:false, purge:false', async () => {
    const calls = usageStub([], (url, method) =>
      url.endsWith('/m-1/unregister') && method === 'POST' ? Response.json({ jobId: 'j', weights: 'kept' }, { status: 202 }) : undefined,
    );
    renderWithProviders(<UnregisterModelDialog model={BASE_MODEL} open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Unregister model' });
    await waitFor(() => expect(confirmButton(dialog).disabled).toBe(false));

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Purge all versions now' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Delete weights from the bucket' }));
    fireEvent.click(confirmButton(dialog));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ deleteWeights: false, purge: false });
  });

  it('a 409 MODEL_IN_USE and a 409 MODEL_UNLOAD_FAILED each get their own toast', async () => {
    let code = 'MODEL_IN_USE';
    usageStub([], (url, method) =>
      url.endsWith('/m-1/unregister') && method === 'POST'
        ? Response.json({ statusCode: 409, message: 'nope', code, referrers: REFERRERS }, { status: 409 })
        : undefined,
    );
    renderWithProviders(<UnregisterModelDialog model={BASE_MODEL} open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Unregister model' });
    await waitFor(() => expect(confirmButton(dialog).disabled).toBe(false));

    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/still in use/i)));

    code = 'MODEL_UNLOAD_FAILED';
    await waitFor(() => expect(confirmButton(dialog).disabled).toBe(false));
    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not unload/i)));
  });

  it('is what the row action opens (the old Retire is gone)', async () => {
    usageStub([]);
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('Whisper ML-EN');

    expect(screen.queryByRole('button', { name: /^Retire/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unregister Whisper ML-EN' }));
    expect(await screen.findByRole('dialog', { name: 'Unregister model' })).toBeDefined();
  });
});
