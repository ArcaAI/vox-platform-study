/**
 * Frame 19 — Prisma Studio screen. The status endpoint decides between a
 * truthful disabled card (never a broken iframe) and the guarded iframe shell
 * around the gateway-served studio; error and loading states round it out.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { PstudioScreen } from '../pstudio-screen';

beforeAll(() => {
    // happy-dom would otherwise fetch the iframe document for real
    // (ECONNREFUSED noise) — assertions only need the element and its src.
    const detached = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM;
    if (detached) detached.settings.disableIframePageLoading = true;
    // With loading disabled happy-dom still reports every mount straight to
    // stderr; drop exactly that message and keep everything else audible.
    const write = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: never[]) => {
        if (typeof chunk === 'string' && chunk.includes('Failed to load iframe page')) return true;
        return write(chunk, ...rest);
    }) as typeof process.stderr.write);
});

afterAll(() => {
    vi.restoreAllMocks();
});

const STATUS_URL = '/api/hope/admin/pstudio/status';
const STUDIO_SRC = '/api/hope/admin/pstudio';

interface RecordedCall {
    url: string;
    method: string;
}

function stubFetch(handler: (url: string) => Response | undefined): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            calls.push({ url, method: init?.method ?? 'GET' });
            const response = handler(url);
            if (!response) throw new Error(`Unhandled fetch: ${init?.method ?? 'GET'} ${url}`);
            return response;
        }),
    );
    return calls;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('PstudioScreen', () => {
    it('renders a truthful disabled card without any iframe when the studio is off', async () => {
        stubFetch((url) => (url === STATUS_URL ? Response.json({ enabled: false }) : undefined));
        renderWithProviders(<PstudioScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'Prisma Studio' })).toBeDefined();
        expect(await screen.findByText('Prisma Studio is disabled')).toBeDefined();
        expect(screen.getByText(/ENABLE_PRISMA_STUDIO/)).toBeDefined();
        expect(screen.queryByTitle('Prisma Studio')).toBeNull();
        expect(screen.queryByRole('link', { name: /open in new tab/i })).toBeNull();
    });

    it('renders the guarded iframe shell with an open-in-new-tab link when enabled', async () => {
        stubFetch((url) => (url === STATUS_URL ? Response.json({ enabled: true }) : undefined));
        renderWithProviders(<PstudioScreen />);

        expect(await screen.findByTitle('Prisma Studio')).toBeDefined();
        expect(screen.getByTitle('Prisma Studio').getAttribute('src')).toBe(STUDIO_SRC);
        expect(screen.getByText('Enabled')).toBeDefined();
        const openLink = screen.getByRole('link', { name: /open in new tab/i });
        expect(openLink.getAttribute('href')).toBe(STUDIO_SRC);
        expect(openLink.getAttribute('target')).toBe('_blank');
        // Production-data caution banner stays visible with the live surface.
        expect(screen.getByText(/production data/i)).toBeDefined();
    });

    it('shows a skeleton surface while the status probe is in flight', () => {
        stubFetch(() => undefined);
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
        const { container } = renderWithProviders(<PstudioScreen />);

        expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
        expect(screen.queryByTitle('Prisma Studio')).toBeNull();
    });

    it('shows an error state with retry when the status probe fails', async () => {
        let fail = true;
        const calls = stubFetch((url) => {
            if (url !== STATUS_URL) return undefined;
            if (fail) return Response.json({ message: 'Studio proxy unreachable' }, { status: 502 });
            return Response.json({ enabled: true });
        });
        renderWithProviders(<PstudioScreen />);

        // The caution banner is also role="alert", so wait on the failure text.
        expect(await screen.findByText(/studio proxy unreachable/i)).toBeDefined();
        expect(screen.queryByTitle('Prisma Studio')).toBeNull();

        fail = false;
        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        await waitFor(() => expect(calls.filter((call) => call.url === STATUS_URL).length).toBe(2));
        expect(await screen.findByTitle('Prisma Studio')).toBeDefined();
    });
});
