import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    getTranscriptionJob,
    getTranscriptionJobStats,
    listTranscriptionJobs,
    listTranscriptionJobsByStatus,
    transcriptionJobStreamPath,
} from '../client';
import { transcriptionJobKeys } from '../keys';

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

function installFetchMock(): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            calls.push({
                url: String(input),
                method: init?.method ?? 'GET',
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            });
            return Response.json({ success: true });
        }),
    );
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('transcriptionJobKeys', () => {
    it('is stable and separates list, stats, status and detail', () => {
        expect(transcriptionJobKeys.list({ page: 1 })).toEqual(transcriptionJobKeys.list({ page: 1 }));
        expect(transcriptionJobKeys.list({ page: 1 })).not.toEqual(transcriptionJobKeys.list({ page: 2 }));
        expect(transcriptionJobKeys.stats()).not.toEqual(transcriptionJobKeys.list());
        expect(transcriptionJobKeys.byStatus('FAILED')).not.toEqual(transcriptionJobKeys.byStatus('QUEUED'));
        expect(transcriptionJobKeys.detail('job-1')[0]).toBe('transcription-jobs');
    });
});

describe('transcription jobs client', () => {
    it('lists tenant-wide jobs through the admin surface (1-based page)', async () => {
        const calls = installFetchMock();
        await listTranscriptionJobs({ page: 1, limit: 20 });
        await getTranscriptionJobStats();
        await listTranscriptionJobsByStatus('FAILED');
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/hope/admin/audio/transcription-jobs?page=1&limit=20',
            'GET /api/hope/admin/audio/transcription-jobs/stats',
            'GET /api/hope/admin/audio/transcription-jobs/status/FAILED',
        ]);
    });

    it('reads per-job detail from the tenant-owned end-user surface', async () => {
        const calls = installFetchMock();
        await getTranscriptionJob('job-9f2ka7c3');
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/audio/transcription-jobs/job-9f2ka7c3']);
    });

    it('builds the direct-gateway SSE path (relative to /api/v1, no leading slash)', () => {
        expect(transcriptionJobStreamPath('job-9f2ka7c3')).toBe('audio/transcription-jobs/job-9f2ka7c3/stream');
    });
});
