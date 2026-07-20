/**
 * Consultation review — click-to-source evidence (TASK-533 B5, GAP-A2).
 *
 * The behaviour that matters clinically is the NEGATIVE case: a claim whose
 * evidence never resolved to a transcript segment must say so. Showing an
 * unhighlighted transcript with no warning reads as "no evidence needed" rather
 * than "evidence missing", which is exactly the wrong inference for a clinician
 * auditing an AI-drafted note.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { ConsultationReview } from '../../api/types';
import { ConsultationReviewScreen } from '../consultation-review-screen';

const CONSULTATION = 'consultation-1';
const TRANSCRIPT = 'Patient reports chest pain. No shortness of breath.';

const review = (overrides: Partial<ConsultationReview> = {}): ConsultationReview => ({
    consultationId: CONSULTATION,
    note: 'S: Chest pain. A: Possible angina.',
    transcripts: [{ contextItemId: 'ctx-1', label: 'Encounter transcript', text: TRANSCRIPT }],
    claims: [
        {
            id: 'claim-grounded',
            text: 'Patient reports chest pain',
            confidence: 0.94,
            status: 'supported',
            evidence: [{ startOffset: 16, endOffset: 26, segmentId: 'seg-1' }],
        },
        {
            id: 'claim-ungrounded',
            text: 'Patient has a family history of MI',
            confidence: 0.41,
            status: 'unverified',
            evidence: [{ startOffset: 0, endOffset: 7, segmentId: null }],
        },
    ],
    ...overrides,
});

function stubFetch(body: ConsultationReview | null, status = 200) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
            if (String(input) === '/api/auth/session') {
                return Response.json({ user: { id: 'u-1', roles: ['TENANT_ADMIN'] }, isElevated: false });
            }
            return body ? Response.json(body) : Response.json({ message: 'boom' }, { status });
        }),
    );
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('ConsultationReviewScreen (TASK-533 B5)', () => {
    it('lists the claims with their grounding state', async () => {
        stubFetch(review());
        renderWithProviders(<ConsultationReviewScreen consultationId={CONSULTATION} />);

        expect(await screen.findByText('Patient reports chest pain')).toBeDefined();
        expect(screen.getByText('Evidence linked')).toBeDefined();
        expect(screen.getByText('No source')).toBeDefined();
    });

    it('highlights the cited transcript span when a grounded claim is selected', async () => {
        stubFetch(review());
        const { container } = renderWithProviders(<ConsultationReviewScreen consultationId={CONSULTATION} />);

        fireEvent.click(await screen.findByText('Patient reports chest pain'));

        const marks = container.querySelectorAll('mark[data-highlight="true"]');
        expect(marks).toHaveLength(1);
        expect(marks[0].textContent).toBe('chest pain');
    });

    it('WARNS when the selected claim has no resolved transcript source', async () => {
        stubFetch(review());
        renderWithProviders(<ConsultationReviewScreen consultationId={CONSULTATION} />);

        fireEvent.click(await screen.findByText('Patient has a family history of MI'));

        const alert = screen.getByRole('alert');
        expect(alert.textContent).toMatch(/no transcript source resolved/i);
    });

    it('renders the transcript intact whether or not anything is selected', async () => {
        stubFetch(review());
        const { container } = renderWithProviders(<ConsultationReviewScreen consultationId={CONSULTATION} />);

        await screen.findByText('Patient reports chest pain');
        const paneText = () => container.querySelector('[data-testid="transcript-pane"]')?.textContent ?? '';
        expect(paneText()).toContain(TRANSCRIPT);

        fireEvent.click(screen.getByText('Patient reports chest pain'));
        // Highlighting must not drop or duplicate any transcript text.
        expect(paneText()).toContain(TRANSCRIPT);
    });

    it('toggles the selection off when the same claim is clicked again', async () => {
        stubFetch(review());
        const { container } = renderWithProviders(<ConsultationReviewScreen consultationId={CONSULTATION} />);

        const claim = await screen.findByText('Patient reports chest pain');
        fireEvent.click(claim);
        expect(container.querySelectorAll('mark[data-highlight="true"]')).toHaveLength(1);

        fireEvent.click(claim);
        expect(container.querySelectorAll('mark[data-highlight="true"]')).toHaveLength(0);
    });

    it('renders an empty state when the consultation has no citation map', async () => {
        stubFetch(review({ claims: [] }));
        renderWithProviders(<ConsultationReviewScreen consultationId={CONSULTATION} />);

        expect(await screen.findByText('No claims recorded')).toBeDefined();
    });

    it('renders an error state when the review cannot be loaded', async () => {
        stubFetch(null, 500);
        renderWithProviders(<ConsultationReviewScreen consultationId={CONSULTATION} />);

        expect(await screen.findByRole('button', { name: /retry/i })).toBeDefined();
    });

    it('has no axe violations', async () => {
        stubFetch(review());
        const { container } = renderWithProviders(<ConsultationReviewScreen consultationId={CONSULTATION} />);
        await screen.findByText('Patient reports chest pain');

        expect(await axe(container)).toHaveNoViolations();
    });
});
