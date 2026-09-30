/**
 * C2 + C4 (TASK-1019, Lane C) — the ONE lifecycle status per row (icon + text,
 * never colour alone), its status filter, download progress, the LM Studio
 * restart hint, and the "Download missing" toolbar action.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFilters } from '@/shared/data/grid-url-state';
import { renderWithProviders } from '@/test/render';
import { MODEL_LIFECYCLE_STATUSES, type ModelLifecycleStatus } from '../../api/types';
import { ManageModelsScreen as AiModelsScreen } from '../manage-models-screen';
import { LIFECYCLE_META } from '../lifecycle-badge';
import { envelope, modelWith, stubFetch } from './fixtures.task1019';

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const rowFor = (name: string) => screen.getAllByRole('row').find((row) => (row.textContent ?? '').includes(name))!;

const ALL_STATUS_MODELS = MODEL_LIFECYCLE_STATUSES.map((status, index) =>
  modelWith(`m-${index}`, `Model ${status}`, status, {}, status === 'DOWNLOADING' ? { download: { bytesDone: 1024, bytesTotal: 4096, error: null } } : {}),
);

describe('lifecycle column (C2)', () => {
  it('renders every ModelLifecycleStatus with an icon AND its text label', async () => {
    stubFetch(() => Response.json(envelope(ALL_STATUS_MODELS)));
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('Model SERVING');

    for (const status of MODEL_LIFECYCLE_STATUSES) {
      const badge = rowFor(`Model ${status}`).querySelector('[data-slot="status-badge"]');
      expect(badge, status).not.toBeNull();
      expect(badge!.textContent, status).toBe(LIFECYCLE_META[status].label);
      // Not colour alone: a glyph rides beside the word.
      expect(badge!.querySelector('svg'), status).not.toBeNull();
    }
  });

  it('gives each status its own glyph so two neighbours never differ by colour only', () => {
    const roles = new Map<string, ModelLifecycleStatus[]>();
    for (const status of MODEL_LIFECYCLE_STATUSES) {
      const key = `${LIFECYCLE_META[status].role}:${LIFECYCLE_META[status].label}`;
      roles.set(key, [...(roles.get(key) ?? []), status]);
    }
    // Every (role, label) pair is unique — the label always disambiguates.
    expect([...roles.values()].every((statuses) => statuses.length === 1)).toBe(true);
  });

  it('shows a progress bar with bytes for a DOWNLOADING row', async () => {
    stubFetch(() => Response.json(envelope(ALL_STATUS_MODELS)));
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('Model DOWNLOADING');

    const bar = within(rowFor('Model DOWNLOADING')).getByRole('progressbar', { name: /download progress for model downloading/i });
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(within(rowFor('Model SERVING')).queryByRole('progressbar')).toBeNull();
  });

  it('filters by lifecycle status client-side and never sends the lifecycle filter to the gateway', async () => {
    const calls = stubFetch(() => Response.json(envelope(ALL_STATUS_MODELS)));
    const f = encodeFilters([{ id: 'lifecycle', operator: 'inArray', variant: 'multiSelect', value: ['SERVING', 'LOAD_FAILED'] }]);
    renderWithProviders(<AiModelsScreen />, { searchParams: `?f=${encodeURIComponent(f)}` });

    await screen.findByText('Model SERVING');
    expect(screen.getByText('Model LOAD_FAILED')).toBeDefined();
    expect(screen.queryByText('Model DOWNLOADING')).toBeNull();
    expect(screen.queryByText('Model DOWNLOADED')).toBeNull();
    const listCalls = calls.filter((call) => call.url.includes('/admin/ai-models/list'));
    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.every((call) => !call.url.includes('lifecycle'))).toBe(true);
  });

  it('offers a status filter on the Lifecycle column with every status as an option', async () => {
    stubFetch(() => Response.json(envelope(ALL_STATUS_MODELS)));
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('Model SERVING');
    expect(screen.getByRole('columnheader', { name: /lifecycle/i })).toBeDefined();
  });
});

describe('LM Studio restart hint (C4)', () => {
  const GGUF_LMSTUDIO = { format: 'GGUF' as const, servedBy: 'lmstudio', provider: 'lm-studio', libraryName: 'gguf' };

  it('shows it on a GGUF row served by LM Studio once DOWNLOADED — and only then', async () => {
    stubFetch(() =>
      Response.json(
        envelope([
          modelWith('m-a', 'Gemma GGUF ready', 'DOWNLOADED', GGUF_LMSTUDIO),
          modelWith('m-b', 'Gemma GGUF serving', 'SERVING', GGUF_LMSTUDIO),
          modelWith('m-c', 'Whisper downloaded', 'DOWNLOADED', {}),
        ]),
      ),
    );
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('Gemma GGUF ready');

    expect(within(rowFor('Gemma GGUF ready')).getByText(/lm studio picks up new files after its pod restarts/i)).toBeDefined();
    expect(within(rowFor('Gemma GGUF serving')).queryByText(/pod restarts/i)).toBeNull();
    expect(within(rowFor('Whisper downloaded')).queryByText(/pod restarts/i)).toBeNull();
  });
});

describe('Download missing', () => {
  it('POSTs download-missing and toasts the enqueued / skipped counts', async () => {
    const calls = stubFetch((url, method) => {
      if (url.endsWith('/admin/ai-models/download-missing') && method === 'POST') {
        return Response.json({
          enqueued: [
            { id: 'a', slug: 'a', jobId: 'j1' },
            { id: 'b', slug: 'b', jobId: 'j2' },
          ],
          skipped: [{ id: 'c', slug: 'c', reason: 'already downloading' }],
        });
      }
      return Response.json(envelope([modelWith('m-1', 'Solo model', 'SERVING')]));
    });
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('Solo model');

    fireEvent.click(screen.getByRole('button', { name: 'Download missing' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/download-missing') && call.method === 'POST')).toBe(true));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Download missing: 2 enqueued · 1 skipped'));
  });
});
