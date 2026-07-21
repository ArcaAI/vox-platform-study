/**
 * Consultation-review types.
 *
 * Mirrors `SummaryMeta.citationsMap` as the gateway serves it. `segmentId` is
 * the field the transcript-segment producers populate — before that fix it
 * was always absent, which is why this screen could not exist.
 */

export interface ReviewEvidenceSpan {
    startOffset: number;
    endOffset: number;
    /** Transcript segment this span resolved to. */
    segmentId?: string | null;
}

export interface ReviewClaim {
    id: string;
    text: string;
    /** Sensor/verifier confidence in [0,1] when scored. */
    confidence?: number | null;
    /** e.g. supported | unsupported | unverified. */
    status?: string | null;
    evidence: ReviewEvidenceSpan[];
}

export interface ReviewTranscript {
    contextItemId: string;
    label?: string | null;
    text: string;
}

export interface ConsultationReview {
    consultationId: string;
    note: string;
    transcripts: ReviewTranscript[];
    claims: ReviewClaim[];
}
