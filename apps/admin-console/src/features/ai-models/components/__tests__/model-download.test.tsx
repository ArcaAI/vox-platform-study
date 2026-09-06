/**
 * `ModelDownloadPanel` / `useModelDownload` against the FROZEN download
 * contract (mocked at the fetch layer — the gateway endpoints may not exist
 * yet, per the ticket): POST starts a job, GET polls it, polling stops on a
 * terminal state, the outcome toasts exactly once, and a model with no
 * downloadable source disables the button with a visible reason.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { renderWithProviders } from '@/test/render';
import type { AiModel } from '../../api/types';
import { ModelDownloadPanel } from '../model-download';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const BASE_MODEL: AiModel = {
  id: 'm-1',
  name: 'Whisper Large v4',
  slug: 'whisper-large-v4',
  description: null,
  category: 'AUDIO',
  taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
  modelType: 'BASE_MODEL',
  source: 'HUGGINGFACE',
  sourceUri: 'openai/whisper-large-v4',
  sourceRevision: null,
  format: 'FASTER_WHISPER',
  pipelineTag: 'automatic-speech-recognition',
  libraryName: 'faster-whisper',
  servedBy: 'stt',
  deploymentKind: 'SELF_HOSTED',
  wireModelId: null,
  license: null,
  gated: false,
  baseModel: null,
  languages: [],
  hfRevision: null,
  bucketPrefix: null,
  primaryObject: null,
  manifestDigest: null,
  availability: 'UNKNOWN',
  availabilityCheckedAt: null,
  availabilityDetail: null,
  isPlatformDefaultFor: [],
  provider: 'built-in',
  architecture: 'whisper',
  memorySizeMb: 3096,
  computeType: 'float16',
  localPath: null,
  checksum: null,
  resourceStatus: 'ENABLED',
  version: 4,
  tags: ['stt'],
  tenantId: 't-1',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
};

interface RecordedCall {
  url: string;
  method: string;
}

function stubFetch(handler: (url: string, method: string, callIndex: number) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      return handler(url, method, calls.length - 1);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ModelDownloadPanel — disabled state', () => {
  it('disables Download with a visible reason when the model has no source', () => {
    renderWithProviders(<ModelDownloadPanel model={{ ...BASE_MODEL, sourceUri: '', localPath: null }} />);

    const button = screen.getByRole('button', { name: /publish/i });
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    const reason = document.getElementById(button.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toMatch(/no source uri/i);
  });

  it('enables Download when a sourceUri is present', () => {
    renderWithProviders(<ModelDownloadPanel model={BASE_MODEL} />);
    expect(screen.getByRole('button', { name: /^publish to bucket$/i })).toHaveProperty('disabled', false);
  });

  it('enables Download when only localPath is set (no sourceUri)', () => {
    renderWithProviders(<ModelDownloadPanel model={{ ...BASE_MODEL, sourceUri: '', localPath: '/mnt/models-bucket/whisper/v1/' }} />);
    expect(screen.getByRole('button', { name: /^publish to bucket$/i })).toHaveProperty('disabled', false);
  });
});

describe('ModelDownloadPanel — start + poll + terminal outcomes', () => {
  it('POSTs to start, then polls GET while DOWNLOADING, and toasts success once DOWNLOADED', async () => {
    const calls = stubFetch((url, method, index) => {
      if (method === 'POST') return Response.json({ jobId: 'job-1', status: 'DOWNLOADING' }, { status: 202 });
      // The mount poll and the one right after start still report running; the
      // next (2s-interval) poll reports done — keeps the real-timer test bounded.
      if (index < 3) return Response.json({ status: 'DOWNLOADING' });
      return Response.json({ status: 'DOWNLOADED', fileSizeMb: 256, sha256: 'abc123', localPath: '/mnt/models-bucket/whisper/v1/' });
    });
    renderWithProviders(<ModelDownloadPanel model={BASE_MODEL} />);

    fireEvent.click(screen.getByRole('button', { name: /^publish to bucket$/i }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls[0].url).toBe('/api/hope/admin/ai-models/m-1/download');

    // While DOWNLOADING the button is disabled and shows the busy label.
    await screen.findByRole('button', { name: /publishing/i });

    // Terminal state reached — the badge flips, the button re-enables, and the
    // outcome toasts exactly once.
    await waitFor(() => expect(screen.getByText('Downloaded')).toBeDefined(), { timeout: 5000 });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Whisper Large v4'));
    expect(toast.error).not.toHaveBeenCalled();

    // Detail fields from the final GET are rendered.
    expect(screen.getByText(/abc123/)).toBeDefined();
    expect(screen.getByText(/mnt\/models-bucket\/whisper\/v1/)).toBeDefined();

    // Polling stopped — no further GETs after the terminal one.
    const getCountAtTerminal = calls.filter((c) => c.method === 'GET').length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((c) => c.method === 'GET').length).toBe(getCountAtTerminal);
  }, 10000);

  it('toasts the failure reason and stops polling on DOWNLOAD_FAILED', async () => {
    stubFetch((url, method, index) => {
      if (method === 'POST') return Response.json({ jobId: 'job-2', status: 'DOWNLOADING' }, { status: 202 });
      if (index < 3) return Response.json({ status: 'DOWNLOADING' });
      return Response.json({ status: 'DOWNLOAD_FAILED', error: 'checksum mismatch' });
    });
    renderWithProviders(<ModelDownloadPanel model={BASE_MODEL} />);

    fireEvent.click(screen.getByRole('button', { name: /^publish to bucket$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('checksum mismatch'), { timeout: 5000 });
    expect(await screen.findByText('Download failed')).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('checksum mismatch');
    // Retry affordance after a failure.
    expect(screen.getByRole('button', { name: /retry publish/i })).toBeDefined();
  }, 10000);

  it('resumes polling on mount for a model already DOWNLOADING (started elsewhere)', async () => {
    // TASK-890 §3.11 — the row carries no `downloadStatus` any more, so "already
    // running" is a fact only the job endpoint holds; the panel asks it on mount.
    const calls = stubFetch(() => Response.json({ status: 'DOWNLOADING' }));
    renderWithProviders(<ModelDownloadPanel model={BASE_MODEL} />);

    await waitFor(() => expect(calls.some((c) => c.method === 'GET')).toBe(true));
    expect(calls[0].url).toBe('/api/hope/admin/ai-models/m-1/download');
    expect(await screen.findByRole('button', { name: /publishing/i })).toHaveProperty('disabled', true);
  });

  it('maps a 409 (already in flight) to a friendly toast and starts polling to catch up', async () => {
    let postCount = 0;
    stubFetch((url, method) => {
      if (method === 'POST') {
        postCount += 1;
        return Response.json({ message: 'already running' }, { status: 409 });
      }
      return Response.json({ status: 'DOWNLOADING' });
    });
    renderWithProviders(<ModelDownloadPanel model={BASE_MODEL} />);

    fireEvent.click(screen.getByRole('button', { name: /^publish to bucket$/i }));

    await waitFor(() => expect(postCount).toBe(1));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A publish is already in progress for this model.'));
    // The 409 still resumes polling so the UI catches up with the real state.
    await screen.findByRole('button', { name: /publishing/i });
  });
});
