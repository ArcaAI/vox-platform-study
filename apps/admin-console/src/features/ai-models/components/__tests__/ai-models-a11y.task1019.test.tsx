/**
 * C5 (TASK-1019, Lane C) — axe: 0 violations on the grid with every lifecycle status, and on each new dialog, in both themes.
 * C6 (TASK-1023) — and on the Register model sheet (each tab), the Download jobs drawer, the Cancel dialog and the read-only grid.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { MODEL_LIFECYCLE_STATUSES } from '../../api/types';
import { ManageModelsScreen as AiModelsScreen } from '../manage-models-screen';
import { AiModelsScreen as AccessScreen } from '../ai-models-screen';
import { CancelDownloadDialog } from '../cancel-download-dialog';
import { DownloadJobsDrawer } from '../download-jobs-drawer';
import { RegisterModelSheet } from '../register-model-sheet';
import { UnregisterModelDialog } from '../unregister-model-dialog';
import { BASE_MODEL, PREVIEW, envelope, modelWith, stubFetch } from './fixtures.task1019';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

const THEMES = ['light', 'dark'] as const;
function applyTheme(theme: (typeof THEMES)[number]) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

const MODELS = MODEL_LIFECYCLE_STATUSES.map((status, index) =>
  modelWith(`m-${index}`, `Model ${status}`, status, {}, status === 'DOWNLOADING' ? { download: { bytesDone: 10, bytesTotal: 100, error: null } } : {}),
);

describe.each(THEMES)('axe — %s theme', (theme) => {
  it('the grid renders no violations with every lifecycle status', async () => {
    applyTheme(theme);
    stubFetch(() => Response.json(envelope(MODELS)));
    const { container } = renderWithProviders(<AiModelsScreen />);
    await screen.findByText('Model SERVING');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the Unregister dialog renders no violations, blocked and unblocked', async () => {
    applyTheme(theme);
    let referrers: unknown[] = [{ kind: 'agent', tenantId: 't-1', id: 'a', name: 'Scribe agent' }];
    stubFetch(() => Response.json({ referrers }));
    const { unmount } = renderWithProviders(<UnregisterModelDialog model={BASE_MODEL} open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Unregister model' });
    await within(dialog).findByRole('list', { name: 'Referrers' });
    expect(await axe(dialog)).toHaveNoViolations();
    unmount();

    referrers = [];
    renderWithProviders(<UnregisterModelDialog model={BASE_MODEL} open onOpenChange={() => {}} />);
    const clean = await screen.findByRole('dialog', { name: 'Unregister model' });
    await waitFor(() => expect((within(clean).getByRole('button', { name: 'Unregister model' }) as HTMLButtonElement).disabled).toBe(false));
    expect(await axe(clean)).toHaveNoViolations();
  });

  it.each(['HUGGINGFACE', 'MLFLOW', 'LOCAL'] as const)('the Register model sheet renders no violations on the %s tab', async (tab) => {
    applyTheme(theme);
    stubFetch((url) => {
      if (url.includes('hub/preview')) return Response.json(PREVIEW);
      if (url.includes('/storage/buckets/')) return Response.json([{ key: 'whisper/f16/model.bin', size: 10 }]);
      return Response.json(null);
    });
    renderWithProviders(<RegisterModelSheet open onOpenChange={() => {}} initialTab={tab} />);
    const dialog = await screen.findByRole('dialog', { name: 'Register model' });
    if (tab === 'HUGGINGFACE') {
      fireEvent.change(within(dialog).getByLabelText(/^repository id/i), { target: { value: 'org/whisper-ml-en' } });
      await within(dialog).findByRole('group', { name: 'Model summary' });
    }
    if (tab === 'LOCAL') await within(dialog).findByRole('button', { name: 'Open folder whisper' });
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it('the Download jobs drawer and the Cancel dialog render no violations', async () => {
    applyTheme(theme);
    stubFetch(() =>
      Response.json([
        { jobId: 'j-1', kind: 'download', aiModelId: 'm-1', modelSlug: 'w', modelName: 'Whisper', state: 'active', bytesDone: 5, bytesTotal: 10, startedAt: '2026-09-30T10:00:00.000Z', finishedAt: null, startedBy: 'u-1', error: null },
      ]),
    );
    const { unmount } = renderWithProviders(<DownloadJobsDrawer open onOpenChange={() => {}} />);
    const drawer = await screen.findByRole('dialog', { name: 'Download jobs' });
    await within(drawer).findByText('Whisper');
    expect(await axe(drawer)).toHaveNoViolations();
    unmount();

    renderWithProviders(<CancelDownloadDialog target={{ id: 'm-1', name: 'Whisper' }} open onOpenChange={() => {}} />);
    expect(await axe(await screen.findByRole('dialog', { name: 'Cancel download' }))).toHaveNoViolations();
  });

  it('the read-only registry grid (non-manager) renders no violations', async () => {
    applyTheme(theme);
    stubFetch((url) =>
      url.includes('/access')
        ? Response.json({ canManage: false, tenantManagementEnabled: false })
        : Response.json({
            data: [
              { id: 'r-1', slug: 'whisper', name: 'Whisper', description: null, taskType: 'AUTOMATIC_SPEECH_RECOGNITION', libraryName: 'whisper.cpp', format: 'WHISPER_CPP', servedBy: 'stt', deploymentKind: 'SELF_HOSTED', license: 'mit', gated: false, languages: ['en'], memorySizeMb: 1, lifecycleStatus: 'SERVING', availability: 'AVAILABLE', isPlatformDefaultFor: [], resourceStatus: 'ENABLED', updatedAt: '2026-07-01T00:00:00.000Z' },
            ],
            total: 1,
            page: 0,
            limit: 25,
            totalPages: 1,
          }),
    );
    const { container } = renderWithProviders(<AccessScreen />);
    await screen.findByText('Whisper');
    expect(await axe(container)).toHaveNoViolations();
  });
});
