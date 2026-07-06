import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { JobDetail, JobSummary, PaginatedJobs, QueueStats } from '../../api/types';
import { QueueDetailScreen } from '../queue-detail-screen';
import { installFetchStub } from './fetch-stub';

const QUEUE: QueueStats = {
    name: 'stt-transcription',
    isPaused: false,
    counts: { waiting: 14, active: 8, completed: 1200, failed: 1, delayed: 2, paused: 0, prioritized: 0 },
    workerCount: 4,
};

const JOBS: JobSummary[] = [
    {
        id: 'job-101',
        name: 'transcribe-consultation',
        queueName: 'stt-transcription',
        status: 'failed',
        progress: null,
        attempts: 3,
        maxAttempts: 3,
        delay: 0,
        timestamp: Date.now() - 60_000,
        processedOn: Date.now() - 30_000,
        finishedOn: Date.now() - 10_000,
        failedReason: 'boom',
        parentId: null,
    },
    {
        id: 'job-202',
        name: 'transcribe-followup',
        queueName: 'stt-transcription',
        status: 'delayed',
        progress: null,
        attempts: 0,
        maxAttempts: 3,
        delay: 5_000,
        timestamp: Date.now() - 5_000,
        processedOn: null,
        finishedOn: null,
        failedReason: null,
        parentId: null,
    },
];

const JOB_DETAIL: JobDetail = {
    ...JOBS[0],
    data: { consultationId: 'cons-9' },
    returnValue: null,
    stacktrace: ['Error: boom'],
    logs: ['started'],
    opts: { attempts: 3, delay: 0, backoff: null, priority: 0, removeOnComplete: true, removeOnFail: false },
};

const QUEUE_URL = '/api/hope/admin/queues/stt-transcription';
const JOBS_URL = `${QUEUE_URL}/jobs`;

function stubQueueRoutes() {
    return installFetchStub(({ url, method }) => {
        // AdminDataGrid persists per-user layout via user/me/settings — no saved layout in tests.
        if (url.includes('/user/me/settings')) return method === 'GET' ? [] : { success: true };
        if (url === QUEUE_URL) return QUEUE;
        if (url.startsWith(`${JOBS_URL}?`)) {
            const envelope: PaginatedJobs = { items: JOBS, total: 2, page: 0, limit: 25 };
            return envelope;
        }
        if (url === `${JOBS_URL}/job-101`) return JOB_DETAIL;
        return undefined;
    });
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('QueueDetailScreen', () => {
    it('renders the queue header, counters and jobs table', async () => {
        stubQueueRoutes();
        renderWithProviders(<QueueDetailScreen name="stt-transcription" />);
        expect(screen.getByRole('heading', { level: 1, name: 'stt-transcription' })).toBeDefined();
        expect(await screen.findByText('job-101')).toBeDefined();
        expect(screen.getByText('transcribe-followup')).toBeDefined();
        expect(screen.getByRole('grid', { name: 'Jobs' })).toBeDefined();
        expect(screen.getByText('Waiting')).toBeDefined();
    });

    it('propagates the URL state filter into the jobs request', async () => {
        const calls = stubQueueRoutes();
        // Typed filters live in the compact `f` URL param (JSON tuples); the screen maps
        // the State facet onto the jobs endpoint's discrete `status` knob (the DTO rejects
        // the generic filters/search/sort params).
        const f = encodeURIComponent(JSON.stringify([['status', 'eq', 'select', 'failed']]));
        renderWithProviders(<QueueDetailScreen name="stt-transcription" />, { searchParams: `?f=${f}` });
        await waitFor(() => expect(calls.some((call) => call.url.startsWith(`${JOBS_URL}?`))).toBe(true));
        const jobsCall = calls.find((call) => call.url.startsWith(`${JOBS_URL}?`));
        expect(jobsCall?.url).toContain('status=failed');
    });

    it('retries a failed job from the row actions', async () => {
        const calls = stubQueueRoutes();
        renderWithProviders(<QueueDetailScreen name="stt-transcription" />);
        await screen.findByText('job-101');
        fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for job job-101' }), { key: 'Enter' });
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Retry' }));
        await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === `${JOBS_URL}/job-101/retry`)).toBe(true));
    });

    it('promotes a delayed job from the row actions', async () => {
        const calls = stubQueueRoutes();
        renderWithProviders(<QueueDetailScreen name="stt-transcription" />);
        await screen.findByText('job-202');
        fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for job job-202' }), { key: 'Enter' });
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Promote' }));
        await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === `${JOBS_URL}/job-202/promote`)).toBe(true));
    });

    it('removes a job after a destructive confirmation', async () => {
        const calls = stubQueueRoutes();
        renderWithProviders(<QueueDetailScreen name="stt-transcription" />);
        await screen.findByText('job-101');
        fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for job job-101' }), { key: 'Enter' });
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Remove job' }));
        await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.url === `${JOBS_URL}/job-101`)).toBe(true));
    });

    it('runs a bulk retry over the selected jobs', async () => {
        const calls = stubQueueRoutes();
        renderWithProviders(<QueueDetailScreen name="stt-transcription" />);
        await screen.findByText('job-101');
        // The grid owns selection now: per-row checkboxes carry the generic "Select row"
        // name and row 0 is job-101. Selecting reveals the bulk action bar.
        fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0]);
        fireEvent.click(await screen.findByRole('button', { name: /retry selected/i }));
        fireEvent.click(await screen.findByRole('button', { name: 'Retry jobs' }));
        await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === `${JOBS_URL}/bulk`)).toBe(true));
        const bulk = calls.find((call) => call.url === `${JOBS_URL}/bulk`);
        expect(bulk?.body).toEqual({ action: 'retry', jobIds: ['job-101'] });
    });

    it('opens the job detail sheet with the payload on row click', async () => {
        stubQueueRoutes();
        renderWithProviders(<QueueDetailScreen name="stt-transcription" />);
        fireEvent.click(await screen.findByText('transcribe-consultation'));
        expect(await screen.findByText(/"consultationId": "cons-9"/)).toBeDefined();
        expect(screen.getByText('Error: boom')).toBeDefined();
    });
});
