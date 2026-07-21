import type { Metadata } from 'next';
import { ConsultationReviewScreen } from '@/features/consultation-review/components/consultation-review-screen';

export const metadata: Metadata = { title: 'Consultation Review' };

/**
 * Consultation review — click-to-source evidence.
 *
 * Tier 30-49 (tenant-scoped): it reads one tenant's clinical encounter, so it
 * sits under `(tenant)` and inherits that group layout's working-tenant guard.
 *
 * `consultationId` is a searchParam rather than a path segment because the
 * screen is reached by deep link from the encounter surfaces; there is no
 * browsable index of consultations to hang a nested route off yet.
 */
export default async function ConsultationReviewPage({ searchParams }: { searchParams: Promise<{ consultationId?: string }> }) {
    const { consultationId } = await searchParams;
    return <ConsultationReviewScreen consultationId={consultationId ?? ''} />;
}
