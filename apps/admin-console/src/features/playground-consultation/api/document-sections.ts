/**
 * TASK-811 §2b (`section.patch`) / TASK-814 DD-3 — the per-document, per-section realtime
 * protocol. Mirrors the gateway's `SectionPatchDto`
 * (`packages/applications/src/services/consultation/live-documentation/realtime/dto/section-patch.dto.ts`)
 * verbatim, transcribed from that file, not from prose.
 *
 * TRANSPORT: an ADDITIVE second event on the SAME `GET :id/live-summary/stream` channel the
 * legacy `LiveSummaryEventDto` already uses (discriminated by `event === 'section.patch'` —
 * the legacy payload carries no `event` field at all). `useDocumentSectionsStream`
 * (`./hooks.ts`) opens its OWN connection to that same path rather than piggybacking on the
 * SDK's `useArcaLiveSummary` (which only ever parses the legacy shape) — the gateway relays
 * over Redis pub/sub, so more than one subscriber on the same consultation is normal.
 */

/** Discriminates the kinds of annotation a section can carry. */
export const SECTION_ANNOTATION_KINDS = ['entity', 'groundedness', 'flagged'] as const;
export type SectionAnnotationKind = (typeof SECTION_ANNOTATION_KINDS)[number];

/** One annotation, addressed LOCALLY — offsets index THIS section's `content`, never a concatenated document. */
export interface SectionAnnotation {
  kind: SectionAnnotationKind;
  start: number;
  end: number;
  type?: string;
  verdict?: 'grounded' | 'ungrounded' | 'unverified';
  icd10?: string;
  score?: number;
}

/** Where a section's content came from — a transcript anchor. */
export interface SectionProvenance {
  transcriptSegmentId?: string;
  transcriptStart?: number;
  transcriptEnd?: number;
}

/** Section state machine (TASK-811 §2d). `empty` renders as a SKELETON, never an error. */
export type SectionState = 'empty' | 'provisional' | 'confirmed' | 'locked';

/** One section's new state, streamed independently of every other section and document. */
export interface SectionPatch {
  event: 'section.patch';
  consultationId: string;
  /** WHICH document — the tenant's `DocumentTemplate.slug` (e.g. `soap_note`, `discharge_summary`). */
  documentKey: string;
  /** WHICH section within that document — the compiled template section key. */
  sectionKey: string;
  title: string;
  /** 0-based render ordinal within the document. */
  idx: number;
  /** Monotonic per-section revision — a patch whose revision is not greater than the one
   *  already held for this (documentKey, sectionKey) MUST be discarded (out-of-order delivery). */
  revision: number;
  state: SectionState;
  content: string;
  annotations?: SectionAnnotation[];
  provenance?: SectionProvenance[];
  documentTemplateVersionId?: string | null;
  updatedAt: string;
}

/** One section, folded into its document's view (sorted by `idx`). */
export interface DocumentSectionView {
  sectionKey: string;
  title: string;
  idx: number;
  revision: number;
  state: SectionState;
  content: string;
  annotations: SectionAnnotation[];
}

/** One document, its sections in render order. */
export interface DocumentView {
  documentKey: string;
  sections: DocumentSectionView[];
}
