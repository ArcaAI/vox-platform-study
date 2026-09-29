/**
 * TASK-999 lane F — `TranscriptionJobDetailDrawer`. New component, new file:
 * every assertion here is RED before this change because the component (and
 * the C-2 fields it reads — `streamSessionId`, `servedBy`, `resultWordCount`,
 * `resultCharCount`, `durationMs`) did not exist.
 */

import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { ServedBy, TranscriptionJob } from '../../api/types';
import { TranscriptionJobDetailDrawer } from '../job-detail-drawer';

const EM_DASH = '—';

function job(overrides: Partial<TranscriptionJob> = {}): TranscriptionJob {
  return {
    id: 'job-drawer-1',
    jobType: 'BATCH',
    agentVersionId: 'av-1',
    resolvedSpec: null,
    consultationId: null,
    contextItemId: null,
    mediaId: 'm-1',
    status: 'COMPLETED',
    progress: 100,
    queuedAt: '2026-09-01T00:00:00.000Z',
    startedAt: '2026-09-01T00:00:05.000Z',
    completedAt: '2026-09-01T00:01:05.000Z',
    resultText: 'hello world',
    resultMetadata: null,
    errorMessage: null,
    errorCode: null,
    retryCount: 0,
    maxRetries: 3,
    workerId: 'w-1',
    tenantId: 'tnt-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:05.000Z',
    createdBy: 'u-1',
    streamSessionId: null,
    servedBy: null,
    resultWordCount: 2,
    resultCharCount: 11,
    durationMs: 60_000,
    ...overrides,
  };
}

/** A resolvedSpec shape carrying just what the drawer reads (`ResolvedAsrSpec`, `@arcaai/types`). */
function resolvedSpecFixture() {
  return {
    schemaVersion: 1,
    runtimeKey: 'rk-primary',
    agent: { slug: 'asr-primary-agent' },
    models: { asr: { slug: 'whisper-large-v3', provider: 'azure' } },
    fallback: {
      kind: 'model',
      autoSwitch: true,
      switchAfterConsecutiveFailures: 2,
      spec: null,
      // `chain` holds FALLBACKS ONLY — the primary is the spec itself
      // (packages/types/src/asr-spec.ts:591). It is never an element here.
      chain: [
        { runtimeKey: 'rk-1', agent: { slug: 'asr-fallback-agent' }, models: { asr: { slug: 'whisper-medium', provider: 'ollama' } } },
      ],
    },
  };
}

function stubJobFetch(fixture: TranscriptionJob): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://test.local').pathname;
      if (path === `/api/hope/audio/transcription-jobs/${fixture.id}`) return Response.json(fixture);
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TranscriptionJobDetailDrawer', () => {
  it('renders the Realtime kind badge and the stream session id for a STREAMING job', async () => {
    const fixture = job({ jobType: 'STREAMING', streamSessionId: 'sess-abc123' });
    stubJobFetch(fixture);
    renderWithProviders(<TranscriptionJobDetailDrawer jobId={fixture.id} open onOpenChange={() => {}} />);

    expect(await screen.findByText('Realtime')).toBeDefined();
    expect(await screen.findByText('sess-abc123')).toBeDefined();
  });

  it('marks only the servedBy.chainIndex entry as served', async () => {
    const servedBy: ServedBy = { chainIndex: 0, source: 'fallback', agentSlug: 'asr-fallback-agent', modelSlug: 'whisper-medium', provider: 'ollama', engine: 'whisper-medium' };
    const fixture = job({ resolvedSpec: resolvedSpecFixture(), servedBy });
    stubJobFetch(fixture);
    renderWithProviders(<TranscriptionJobDetailDrawer jobId={fixture.id} open onOpenChange={() => {}} />);

    await screen.findByText('azure · whisper-large-v3');
    const servedBadges = screen.getAllByText('Served');
    expect(servedBadges).toHaveLength(1);

    const fallbackRow = screen.getByText('ollama · whisper-medium').closest('li');
    const primaryRow = screen.getByText('azure · whisper-large-v3').closest('li');
    expect(fallbackRow?.textContent).toContain('Served');
    expect(primaryRow?.textContent).not.toContain('Served');
  });

  // RED before the fix: a primary-served job carries chainIndex -1 by construction
  // (the primary is not an element of `fallback.chain`), so the drawer branched on the
  // index alone and told the user the engine "could not be matched" — on the common case.
  it('marks the primary when it served, and shows no unmatched note', async () => {
    const servedBy: ServedBy = { chainIndex: -1, source: 'primary', agentSlug: 'asr-primary-agent', modelSlug: 'whisper-large-v3', provider: 'azure', engine: 'azure' };
    const fixture = job({ resolvedSpec: resolvedSpecFixture(), servedBy });
    stubJobFetch(fixture);
    renderWithProviders(<TranscriptionJobDetailDrawer jobId={fixture.id} open onOpenChange={() => {}} />);

    const primaryRow = (await screen.findByText('azure · whisper-large-v3')).closest('li');
    expect(primaryRow?.textContent).toContain('Served');
    expect(screen.getAllByText('Served')).toHaveLength(1);
    expect(screen.queryByText(/could not be matched/i)).toBeNull();
  });

  it('marks nothing and shows the not-recorded note when servedBy is null', async () => {
    const fixture = job({ resolvedSpec: resolvedSpecFixture(), servedBy: null });
    stubJobFetch(fixture);
    renderWithProviders(<TranscriptionJobDetailDrawer jobId={fixture.id} open onOpenChange={() => {}} />);

    expect(await screen.findByText(/showing the resolved chain only/i)).toBeDefined();
    expect(screen.queryByText('Served')).toBeNull();
  });

  it('renders the unmatched explanation and marks nothing when chainIndex is -1', async () => {
    const servedBy: ServedBy = { chainIndex: -1, source: 'fallback', agentSlug: null, modelSlug: null, provider: null, engine: null };
    const fixture = job({ resolvedSpec: resolvedSpecFixture(), servedBy });
    stubJobFetch(fixture);
    renderWithProviders(<TranscriptionJobDetailDrawer jobId={fixture.id} open onOpenChange={() => {}} />);

    expect(await screen.findByText(/could not be matched/i)).toBeDefined();
    expect(screen.queryByText('Served')).toBeNull();
  });

  it('renders resultWordCount 0 as "0" — a real empty transcript, not "never measured"', async () => {
    const fixture = job({ resultWordCount: 0, resultCharCount: 42 });
    stubJobFetch(fixture);
    renderWithProviders(<TranscriptionJobDetailDrawer jobId={fixture.id} open onOpenChange={() => {}} />);

    await screen.findByText('Words');
    expect(screen.getByText('Words').nextElementSibling?.textContent).toBe('0');
  });

  it('renders resultWordCount/resultCharCount null as the em-dash ("never measured")', async () => {
    const fixture = job({ resultWordCount: null, resultCharCount: null });
    stubJobFetch(fixture);
    renderWithProviders(<TranscriptionJobDetailDrawer jobId={fixture.id} open onOpenChange={() => {}} />);

    await screen.findByText('Words');
    expect(screen.getByText('Words').nextElementSibling?.textContent).toBe(EM_DASH);
    expect(screen.getByText('Characters').nextElementSibling?.textContent).toBe(EM_DASH);
  });

  it('renders the em-dash for a running job (durationMs: null), never "0"', async () => {
    const fixture = job({ status: 'PROCESSING', completedAt: null, durationMs: null });
    stubJobFetch(fixture);
    renderWithProviders(<TranscriptionJobDetailDrawer jobId={fixture.id} open onOpenChange={() => {}} />);

    await screen.findByText('Duration');
    expect(screen.getByText('Duration').nextElementSibling?.textContent).toBe(EM_DASH);
  });
});
