/**
 * TDD tests for TASK-532 B-5 — `EditBurdenCard` (M-09 tenant leg).
 *
 * `GET admin/harness/edit-burden?consultationId=` returns DERIVED SCALARS only
 * (edit distance, deferral, time-to-sign) — the note text never leaves the
 * service. A 404 covers both an absent and a cross-tenant consultation
 * (404-over-403), so it is an EMPTY state, not an error.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { EditBurden } from '../../api/types';
import { EditBurdenCard } from '../edit-burden-card';
import { installFetchStub, type RecordedCall } from './fetch-stub';


const BURDEN: EditBurden = {
    consultationId: 'cons-77',
    editDistance: 42,
    editDistanceRatio: 0.18,
    deferralRate: 0.25,
    gateDecisionTotal: 4,
    deferralCount: 1,
    timeToSignSeconds: 5_400,
    deliveredAt: '2026-07-04T10:00:00.000Z',
    signedAt: '2026-07-04T11:30:00.000Z',
};

const EMPTY_BURDEN: EditBurden = {
    consultationId: 'cons-88',
    editDistance: null,
    editDistanceRatio: null,
    deferralRate: null,
    gateDecisionTotal: 0,
    deferralCount: 0,
    timeToSignSeconds: null,
    deliveredAt: null,
    signedAt: null,
};

function stubRoutes(respond: (call: RecordedCall) => Response | unknown = () => BURDEN) {
    return installFetchStub((call: RecordedCall) => {
        if (call.url.startsWith('/api/hope/admin/harness/edit-burden')) return respond(call);
        return undefined;
    });
}

function lookup(consultationId: string) {
    fireEvent.change(screen.getByLabelText('Consultation ID'), { target: { value: consultationId } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('EditBurdenCard', () => {
    it('prompts for a consultation id and fires no read before submit', () => {
        const calls = stubRoutes();
        renderWithProviders(<EditBurdenCard />);

        expect(screen.getByLabelText('Consultation ID')).toBeDefined();
        expect(screen.getByText('Look up a consultation')).toBeDefined();
        expect(calls.some((call) => call.url.includes('edit-burden'))).toBe(false);
    });

    it('renders the derived scalars for a consultation with telemetry', async () => {
        const calls = stubRoutes();
        renderWithProviders(<EditBurdenCard />);

        lookup('cons-77');

        const stats = await screen.findByRole('list', { name: 'Edit burden' });
        expect(within(stats).getByText('42')).toBeDefined();
        expect(within(stats).getByText('18%')).toBeDefined();
        expect(within(stats).getByText('25%')).toBeDefined();
        expect(within(stats).getByText('1 h 30 min')).toBeDefined();

        const read = calls.find((call) => call.url.includes('edit-burden'));
        expect(new URL(read?.url ?? '', 'http://test').searchParams.get('consultationId')).toBe('cons-77');
    });

    it('renders a zeroed-but-present result as data, not as empty', async () => {
        stubRoutes(() => EMPTY_BURDEN);
        renderWithProviders(<EditBurdenCard />);

        lookup('cons-88');

        const stats = await screen.findByRole('list', { name: 'Edit burden' });
        expect(within(stats).getAllByText('—').length).toBeGreaterThan(0);
        expect(screen.queryByText('No edit-burden telemetry')).toBeNull();
    });

    it('renders an empty state (not an error) when the lookup 404s', async () => {
        stubRoutes(() => Response.json({ statusCode: 404, message: 'Not found' }, { status: 404 }));
        renderWithProviders(<EditBurdenCard />);

        lookup('cons-missing');

        expect(await screen.findByText('No edit-burden telemetry')).toBeDefined();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('still renders the error state for a non-404 failure', async () => {
        stubRoutes(() => Response.json({ statusCode: 503, message: 'harness unreachable' }, { status: 503 }));
        renderWithProviders(<EditBurdenCard />);

        lookup('cons-77');

        expect(await screen.findByText('harness unreachable')).toBeDefined();
        expect(screen.getByRole('alert')).toBeDefined();
    });

    it('shows content-shaped skeletons while the lookup is in flight', async () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
        const { container } = renderWithProviders(<EditBurdenCard />);

        lookup('cons-77');

        await waitFor(() => expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0));
    });

    it('has no axe violations with a loaded result', async () => {
        stubRoutes();
        const { container } = renderWithProviders(<EditBurdenCard />);

        lookup('cons-77');
        await screen.findByRole('list', { name: 'Edit burden' });
        await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
    });

    it('has no axe violations in the dark theme', async () => {
        document.documentElement.classList.add('dark');
        try {
            stubRoutes();
            const { container } = renderWithProviders(<EditBurdenCard />);
            lookup('cons-77');
            await screen.findByRole('list', { name: 'Edit burden' });
            await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
        } finally {
            document.documentElement.classList.remove('dark');
        }
    });
});
