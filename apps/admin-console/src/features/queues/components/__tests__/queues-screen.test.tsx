import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { QueueStats } from '../../api/types';
import { QueuesScreen } from '../queues-screen';
import { installFetchStub, type FetchHandler, type RecordedCall } from './fetch-stub';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

/** Layout persistence reads GET user/me/settings on mount; tests have no saved layout. */
function stubFetch(handle: FetchHandler): RecordedCall[] {
    return installFetchStub((call) => {
        if (call.url.includes('/user/me/settings')) return call.method === 'GET' ? [] : { success: true };
        return handle(call);
    });
}

const QUEUES: QueueStats[] = [
    {
        name: 'stt-transcription',
        isPaused: false,
        counts: { waiting: 14, active: 8, completed: 1200, failed: 1, delayed: 2, paused: 0, prioritized: 0 },
        workerCount: 4,
    },
    {
        name: 'smr-summaries',
        isPaused: true,
        counts: { waiting: 3, active: 0, completed: 480, failed: 0, delayed: 0, paused: 3, prioritized: 0 },
        workerCount: 2,
    },
];

const LIST_URL = '/api/hope/admin/queues';

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    push.mockClear();
});

describe('QueuesScreen', () => {
    it('renders the queue table with status and counts', async () => {
        stubFetch(({ url }) => (url === LIST_URL ? QUEUES : undefined));
        renderWithProviders(<QueuesScreen />);
        expect(screen.getByRole('heading', { level: 1, name: 'Queues & Jobs' })).toBeDefined();
        expect(await screen.findByText('stt-transcription')).toBeDefined();
        expect(screen.getByText('smr-summaries')).toBeDefined();
        expect(screen.getByText('Paused')).toBeDefined();
        expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
        expect(screen.getByRole('grid', { name: 'Queues' })).toBeDefined();
    });

    it('shows a neutral empty state when no queues are registered', async () => {
        stubFetch(({ url }) => (url === LIST_URL ? [] : undefined));
        renderWithProviders(<QueuesScreen />);
        expect(await screen.findByText('No queues registered')).toBeDefined();
    });

    it('shows a block error state and retries the request', async () => {
        let fail = true;
        const calls = stubFetch(({ url }) => {
            if (url !== LIST_URL) return undefined;
            if (fail) return Response.json({ message: 'Service unavailable' }, { status: 503 });
            return QUEUES;
        });
        renderWithProviders(<QueuesScreen />);
        expect(await screen.findByRole('alert')).toBeDefined();
        fail = false;
        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        await waitFor(() => expect(calls.filter((call) => call.url === LIST_URL).length).toBe(2));
        expect(await screen.findByText('stt-transcription')).toBeDefined();
    });

    it('pauses a running queue after confirmation', async () => {
        const calls = stubFetch(({ url }) => (url === LIST_URL ? QUEUES : undefined));
        renderWithProviders(<QueuesScreen />);
        await screen.findByText('stt-transcription');
        fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for stt-transcription' }), { key: 'Enter' });
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Pause' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Pause queue' }));
        await waitFor(() =>
            expect(calls.some((call) => call.method === 'POST' && call.url === '/api/hope/admin/queues/stt-transcription/pause')).toBe(true),
        );
    });

    it('resumes a paused queue after confirmation', async () => {
        const calls = stubFetch(({ url }) => (url === LIST_URL ? QUEUES : undefined));
        renderWithProviders(<QueuesScreen />);
        await screen.findByText('smr-summaries');
        fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for smr-summaries' }), { key: 'Enter' });
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Resume' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Resume queue' }));
        await waitFor(() =>
            expect(calls.some((call) => call.method === 'POST' && call.url === '/api/hope/admin/queues/smr-summaries/resume')).toBe(true),
        );
    });

    it('cleans a queue through the destructive dialog with a state selector', async () => {
        const calls = stubFetch(({ url }) => {
            if (url === LIST_URL) return QUEUES;
            if (url.endsWith('/clean')) return { removedJobIds: [], count: 12 };
            return undefined;
        });
        renderWithProviders(<QueuesScreen />);
        await screen.findByText('stt-transcription');
        fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for stt-transcription' }), { key: 'Enter' });
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Clean jobs' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Clean queue' }));
        await waitFor(() =>
            expect(calls.some((call) => call.method === 'POST' && call.url === '/api/hope/admin/queues/stt-transcription/clean')).toBe(true),
        );
        const clean = calls.find((call) => call.url.endsWith('/clean'));
        expect(clean?.body).toEqual({ status: 'completed', gracePeriodMs: 0 });
    });

    it('navigates to the queue detail on row click', async () => {
        stubFetch(({ url }) => (url === LIST_URL ? QUEUES : undefined));
        renderWithProviders(<QueuesScreen />);
        fireEvent.click(await screen.findByText('stt-transcription'));
        expect(push).toHaveBeenCalledWith('/queues/stt-transcription');
    });
});
