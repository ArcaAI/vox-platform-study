/**
 * TASK-999 lane F — the Kind (Batch/Realtime/All) filter on the
 * transcription-jobs screen. New file, deliberately separate from the
 * existing `transcription-jobs-screen.test.tsx` (frame-35 baseline, owned by
 * an earlier ticket) — this one only exercises the new facet.
 *
 * RED before this change: the screen had no `jobType` facet at all, so
 * selecting one via the grid's `f` url param had no column to bind to and
 * the list request never carried a `jobType` query param under any
 * selection.
 */

import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { TranscriptionJob, TranscriptionJobStats } from '../../api/types';
import { TranscriptionJobsScreen } from '../transcription-jobs-screen';

function job(overrides: Partial<TranscriptionJob> = {}): TranscriptionJob {
  return {
    id: 'job-batch-1',
    jobType: 'BATCH',
    agentVersionId: 'av-1',
    resolvedSpec: null,
    consultationId: null,
    contextItemId: null,
    mediaId: 'm-1',
    status: 'COMPLETED',
    progress: 100,
    queuedAt: '2026-09-01T00:00:00.000Z',
    startedAt: '2026-09-01T00:00:01.000Z',
    completedAt: '2026-09-01T00:01:00.000Z',
    resultText: null,
    resultMetadata: null,
    errorMessage: null,
    errorCode: null,
    retryCount: 0,
    maxRetries: 3,
    workerId: 'w-1',
    tenantId: 'tnt-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
    createdBy: 'u-1',
    streamSessionId: null,
    servedBy: null,
    resultWordCount: 5,
    resultCharCount: 20,
    durationMs: 59000,
    ...overrides,
  };
}

const STATS: TranscriptionJobStats = { queued: 0, processing: 0, completed: 1, failed: 0, cancelled: 0, dead: 0 };

function sessionResponse() {
  const base = { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] };
  return {
    user: base,
    isElevated: true,
    workingTenantId: 'tnt-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: null,
    impersonatingUsername: null,
    effectiveUser: { ...base, tenantId: null, departmentId: null },
    effectiveIsElevated: true,
    effectiveTenantId: 'tnt-1',
  };
}

interface RecordedCall {
  url: string;
  method: string;
}

function stubFetch(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? 'GET' };
      calls.push(call);
      const path = new URL(call.url, 'http://test.local').pathname;
      if (call.method === 'GET' && path === '/api/auth/session') return Response.json(sessionResponse());
      if (call.url.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
      if (call.method === 'GET' && path === '/api/hope/admin/audio/transcription-jobs') {
        return Response.json({ data: [job()], total: 1, page: 1, limit: 25, totalPages: 1 });
      }
      if (call.method === 'GET' && path === '/api/hope/admin/audio/transcription-jobs/stats') return Response.json(STATS);
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function findListCall(calls: RecordedCall[]): RecordedCall | undefined {
  return calls.find((call) => new URL(call.url, 'http://test.local').pathname === '/api/hope/admin/audio/transcription-jobs');
}

describe('TranscriptionJobsScreen — Kind filter', () => {
  it('defaults to All and sends no jobType param', async () => {
    const calls = stubFetch();
    renderWithProviders(<TranscriptionJobsScreen />);

    await screen.findByText('job-batch-1');
    const listCall = findListCall(calls);
    expect(listCall).toBeDefined();
    expect(new URL(listCall!.url, 'http://test.local').searchParams.has('jobType')).toBe(false);
  });

  it('sends the selected Kind as the jobType query param', async () => {
    const f = encodeURIComponent(JSON.stringify([['jobType', 'eq', 'select', 'STREAMING']]));
    const calls = stubFetch();
    renderWithProviders(<TranscriptionJobsScreen />, { searchParams: `?f=${f}` });

    await waitFor(() => {
      const listCall = findListCall(calls);
      expect(listCall).toBeDefined();
      expect(new URL(listCall!.url, 'http://test.local').searchParams.get('jobType')).toBe('STREAMING');
    });
  });
});
