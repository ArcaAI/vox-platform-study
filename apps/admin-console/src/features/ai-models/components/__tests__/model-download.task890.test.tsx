/**
 * TASK-890 §2.7 #14 / §3.11 — the registry no longer carries the four
 * download columns, so the console must stop reading them.
 *
 * `AiModel.downloadStatus` was DROPPED from the schema and from `ModelResponse`.
 * A UI that still reads it does not fail loudly — it reads `undefined` and
 * quietly decides "not downloading", which is why the publish panel silently
 * stopped resuming a run that was already in flight. The publish JOB's own
 * status endpoint is the only source of truth left, so the panel asks it once
 * on mount instead of trusting a field that cannot exist.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { AiModel } from '../../api/types';
import { ModelDownloadPanel } from '../model-download';

/** A registry row EXACTLY as the gateway serves it today — no download columns. */
const WIRE_MODEL = {
  id: 'm-1',
  name: 'Whisper',
  slug: 'whisper',
  description: null,
  category: 'AUDIO',
  taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
  modelType: 'BASE_MODEL',
  source: 'HUGGINGFACE',
  sourceUri: 'openai/whisper-large-v3',
  sourceRevision: null,
  format: 'SAFETENSOR',
  libraryName: 'transformers',
  servedBy: 'stt',
  deploymentKind: 'SELF_HOSTED',
  languages: [],
  bucketPrefix: null,
  primaryObject: null,
  availability: 'UNKNOWN',
  availabilityCheckedAt: null,
  isPlatformDefaultFor: [],
  provider: 'built-in',
  localPath: null,
  checksum: null,
  resourceStatus: 'ENABLED',
  version: 4,
  tags: [],
  tenantId: 't-1',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
} as unknown as AiModel;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the publish panel after the download columns were dropped', () => {
  it('asks the publish job for the state instead of reading a column that no longer exists', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/auth/session') return Response.json({ user: { id: 'u-1', roles: ['SUPER_ADMIN'] }, isElevated: true });
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        return Response.json({ status: 'DOWNLOADING' });
      }),
    );

    renderWithProviders(<ModelDownloadPanel model={WIRE_MODEL} />);

    await waitFor(() => expect(calls).toContain('GET /api/hope/admin/ai-models/m-1/download'));
    // And the run in flight is reflected, which is what the dropped column used to do.
    await waitFor(() => expect(screen.getByRole('button', { name: /publishing/i })).toHaveProperty('disabled', true));
  });

  it('reports an idle model as not published rather than guessing from an absent field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === '/api/auth/session') return Response.json({ user: { id: 'u-1', roles: ['SUPER_ADMIN'] }, isElevated: true });
        return Response.json({ status: 'NOT_DOWNLOADED' });
      }),
    );

    renderWithProviders(<ModelDownloadPanel model={WIRE_MODEL} />);

    expect(await screen.findByRole('button', { name: /^publish to bucket$/i })).toBeDefined();
  });
});
