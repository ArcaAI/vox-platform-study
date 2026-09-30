/**
 * TASK-1023 (C3) — the Download jobs drawer, the Cancel dialog (default: keep the registration) and the grid
 * reflecting a cancelled download.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import { renderWithProviders } from '@/test/render';
import type { PublisherJobView } from '../../api/types';
import { CancelDownloadDialog } from '../cancel-download-dialog';
import { DownloadJobsDrawer } from '../download-jobs-drawer';
import { ManageModelsScreen } from '../manage-models-screen';
import { envelope, modelWith, stubFetch } from './fixtures.task1019';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const JOBS: PublisherJobView[] = [
  {
    jobId: 'j-1',
    kind: 'download',
    aiModelId: 'm-1',
    modelSlug: 'whisper-ml-en',
    modelName: 'Whisper ML-EN',
    state: 'active',
    bytesDone: 512 * 1024 ** 2,
    bytesTotal: 1024 * 1024 ** 2,
    startedAt: '2026-09-30T10:00:00.000Z',
    finishedAt: null,
    startedBy: 'user-7',
    error: null,
  },
  {
    jobId: 'j-2',
    kind: 'download',
    aiModelId: 'm-2',
    modelSlug: 'gemma',
    modelName: 'Gemma',
    state: 'failed',
    bytesDone: 10,
    bytesTotal: 100,
    startedAt: '2026-09-30T09:00:00.000Z',
    finishedAt: '2026-09-30T09:05:00.000Z',
    startedBy: null,
    error: { code: 'HF_DOWNLOAD_FAILED', message: 'Connection reset by peer' },
  },
  {
    jobId: 'j-3',
    kind: 'unregister',
    aiModelId: 'm-3',
    modelSlug: 'old',
    modelName: 'Old model',
    state: 'waiting',
    bytesDone: null,
    bytesTotal: null,
    startedAt: '2026-09-30T09:30:00.000Z',
    finishedAt: null,
    startedBy: null,
    error: null,
  },
];

describe('DownloadJobsDrawer', () => {
  it('lists jobs with kind, state, progress + bytes, started by and the failure text', async () => {
    stubFetch(() => Response.json(JOBS));
    renderWithProviders(<DownloadJobsDrawer open onOpenChange={() => {}} />);
    const drawer = await screen.findByRole('dialog', { name: 'Download jobs' });

    expect(await within(drawer).findByText('Whisper ML-EN')).toBeDefined();
    expect(within(drawer).getByText('Active')).toBeDefined();
    expect(within(drawer).getByRole('progressbar', { name: /progress for whisper ml-en/i }).getAttribute('aria-valuenow')).toBe('50');
    expect(within(drawer).getByText(/512 MB \/ 1 GB/)).toBeDefined();
    expect(within(drawer).getByText('user-7')).toBeDefined();
    expect(within(drawer).getByText('Connection reset by peer')).toBeDefined();
    expect(within(drawer).getByText('Failed')).toBeDefined();
    expect(within(drawer).getByText('Unregister')).toBeDefined();
  });

  it('offers Cancel only on a waiting or active DOWNLOAD', async () => {
    stubFetch(() => Response.json(JOBS));
    renderWithProviders(<DownloadJobsDrawer open onOpenChange={() => {}} />);
    const drawer = await screen.findByRole('dialog', { name: 'Download jobs' });
    await within(drawer).findByText('Whisper ML-EN');
    expect(within(drawer).getByRole('button', { name: 'Cancel download of Whisper ML-EN' })).toBeDefined();
    expect(within(drawer).queryByRole('button', { name: 'Cancel download of Gemma' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /cancel download of old model/i })).toBeNull();
  });

  it('shows an empty state when there are no jobs', async () => {
    stubFetch(() => Response.json([]));
    renderWithProviders(<DownloadJobsDrawer open onOpenChange={() => {}} />);
    expect(await screen.findByText('No download jobs yet')).toBeDefined();
  });

  it('cancelling asks first, defaults to KEEPING the registration, and posts the cancel', async () => {
    const calls = stubFetch((url, method) =>
      url.endsWith('/m-1/download/cancel') && method === 'POST'
        ? Response.json({ jobId: 'j-1', outcome: 'cancelling', unregisterJobId: null }, { status: 202 })
        : Response.json(JOBS),
    );
    renderWithProviders(<DownloadJobsDrawer open onOpenChange={() => {}} />);
    const drawer = await screen.findByRole('dialog', { name: 'Download jobs' });
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Cancel download of Whisper ML-EN' }));

    const dialog = await screen.findByRole('dialog', { name: 'Cancel download' });
    const remove = within(dialog).getByRole('checkbox', { name: /also remove the registration/i });
    expect(remove.getAttribute('aria-checked')).toBe('false');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel download' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.url).toBe('/api/hope/admin/ai-models/m-1/download/cancel');
    expect(post.body).toEqual({ removeRegistration: false });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('sends removeRegistration: true when the box is ticked', async () => {
    const calls = stubFetch((url, method) =>
      method === 'POST' ? Response.json({ jobId: 'j-1', outcome: 'removed', unregisterJobId: 'u-1' }, { status: 202 }) : Response.json(JOBS),
    );
    renderWithProviders(<DownloadJobsDrawer open onOpenChange={() => {}} />);
    const drawer = await screen.findByRole('dialog', { name: 'Download jobs' });
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Cancel download of Whisper ML-EN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel download' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /also remove the registration/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel download' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ removeRegistration: true });
  });

  it('a 409 JOB_NOT_ACTIVE says the download already finished', async () => {
    stubFetch((url, method) =>
      method === 'POST' ? Response.json({ statusCode: 409, message: 'not active', code: 'JOB_NOT_ACTIVE' }, { status: 409 }) : Response.json(JOBS),
    );
    renderWithProviders(<CancelDownloadDialog target={{ id: 'm-1', name: 'Whisper ML-EN' }} open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Cancel download' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel download' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/already finished/i)));
  });

  it('has no axe violations (drawer and dialog)', async () => {
    stubFetch(() => Response.json(JOBS));
    renderWithProviders(<DownloadJobsDrawer open onOpenChange={() => {}} />);
    const drawer = await screen.findByRole('dialog', { name: 'Download jobs' });
    await within(drawer).findByText('Whisper ML-EN');
    expect(await axe(drawer)).toHaveNoViolations();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel download of Whisper ML-EN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel download' });
    expect(await axe(dialog)).toHaveNoViolations();
  });
});

describe('ManageModelsScreen — download jobs + cancel', () => {
  it('the header shows the active-job count and opens the drawer', async () => {
    stubFetch((url) => (url.includes('/admin/ai-models/jobs') ? Response.json(JOBS) : Response.json(envelope([modelWith('m-1', 'Whisper ML-EN', 'DOWNLOADING')]))));
    renderWithProviders(<ManageModelsScreen />);
    const button = await screen.findByRole('button', { name: /download jobs/i });
    await waitFor(() => expect(within(button).getByText('2')).toBeDefined()); // active + waiting
    fireEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Download jobs' })).toBeDefined();
  });

  it('a DOWNLOADING row offers "Cancel download", and the row shows "Download cancelled" after the refetch', async () => {
    let cancelled = false;
    const calls = stubFetch((url, method) => {
      if (url.includes('/admin/ai-models/jobs')) return Response.json([]);
      if (url.endsWith('/m-1/download/cancel') && method === 'POST') {
        cancelled = true;
        return Response.json({ jobId: 'j-1', outcome: 'cancelling', unregisterJobId: null }, { status: 202 });
      }
      if (url.includes('/admin/ai-models/list')) {
        return Response.json(envelope([modelWith('m-1', 'Whisper ML-EN', cancelled ? 'DOWNLOAD_CANCELLED' : 'DOWNLOADING')]));
      }
      return Response.json(null);
    });
    renderWithProviders(<ManageModelsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel download of Whisper ML-EN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel download' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel download' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(await screen.findByText('Download cancelled')).toBeDefined();
    // Not downloading any more → no cancel action on the row.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel download of Whisper ML-EN' })).toBeNull());
  });
});
