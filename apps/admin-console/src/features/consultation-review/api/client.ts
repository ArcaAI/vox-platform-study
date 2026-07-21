/**
 * Consultation-review client. Gateway-relative — the shared core
 * prepends the `/api/hope` BFF mount, so nothing here reaches the gateway direct.
 */
import { getJson } from '@/shared/api';
import type { ConsultationReview } from './types';

const BASE = 'admin/harness';

/** The signed note + its transcripts + the claim/evidence map for one encounter. */
export function getConsultationReview(consultationId: string): Promise<ConsultationReview> {
    return getJson(`${BASE}/consultations/${encodeURIComponent(consultationId)}/review`);
}
