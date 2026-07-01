/**
 * TASK-380 — Tenant Dashboard consultation derivations.
 *
 * Pure functions over `useAdminConsultations().list()` rows: the new-vs-revisit
 * split, the pending-review count, and a "today" filter. Type-only SDK import
 * keeps this testable under the app's `@arcaai/vox` vitest stub.
 *
 * NOTE: the SDK's `isRevisit` only inspects `metadata.parentConsultationId`,
 * which does not fit the `AdminConsultation` shape. Per the task spec
 * (`Consultation.parentConsultationId` NULL = new visit) we read the top-level
 * field, with a `metadata` fallback for forward-compatibility.
 */

import type { AdminConsultation } from '@arcaai/vox';

/** Backend note-lifecycle statuses that count as "awaiting a doctor's review". */
const PENDING_REVIEW_STATUSES = new Set(['pending_review', 'draft_pending_sensors']);

function readParentId(consultation: AdminConsultation): unknown {
    if (consultation.parentConsultationId != null) return consultation.parentConsultationId;
    const metadata = consultation.metadata as { parentConsultationId?: unknown } | undefined;
    return metadata?.parentConsultationId;
}

/** True when the consultation references a parent (a follow-up / re-visit). */
export function isRevisitConsultation(consultation: AdminConsultation): boolean {
    const parent = readParentId(consultation);
    return typeof parent === 'string' ? parent.length > 0 : parent != null;
}

export interface VisitSplit {
    total: number;
    newVisits: number;
    revisits: number;
}

/** Split a consultation list into total / new / revisit counts. */
export function splitVisits(consultations: AdminConsultation[]): VisitSplit {
    let revisits = 0;
    for (const c of consultations) {
        if (isRevisitConsultation(c)) revisits += 1;
    }
    return { total: consultations.length, newVisits: consultations.length - revisits, revisits };
}

/** Count consultations whose note is awaiting review (PENDING_REVIEW / DRAFT_PENDING_SENSORS). */
export function countPendingReview(consultations: AdminConsultation[]): number {
    return consultations.reduce((count, c) => (c.status && PENDING_REVIEW_STATUSES.has(String(c.status).toLowerCase()) ? count + 1 : count), 0);
}

function isSameCalendarDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Keep only consultations created on the same calendar day as `reference`. */
export function filterToday(consultations: AdminConsultation[], reference: Date = new Date()): AdminConsultation[] {
    return consultations.filter((c) => {
        if (!c.createdAt) return false;
        const created = new Date(c.createdAt);
        return !Number.isNaN(created.getTime()) && isSameCalendarDay(created, reference);
    });
}
