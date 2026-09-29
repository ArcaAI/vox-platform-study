/** C5 (TASK-1019, Lane C) — axe: 0 violations on the grid with every lifecycle status, and on each new dialog, in both themes. */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { MODEL_LIFECYCLE_STATUSES } from '../../api/types';
import { AiModelsScreen } from '../ai-models-screen';
import { RegisterFromHubSheet } from '../register-from-hub-sheet';
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

  it('the Register from Hugging Face drawer (with a loaded preview) renders no violations', async () => {
    applyTheme(theme);
    stubFetch(() => Response.json(PREVIEW));
    renderWithProviders(<RegisterFromHubSheet open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Register from Hugging Face' });
    fireEvent.change(within(dialog).getByLabelText(/^repository id/i), { target: { value: 'org/whisper-ml-en' } });
    await within(dialog).findByText(/3 GB/);
    expect(await axe(dialog)).toHaveNoViolations();
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
});
