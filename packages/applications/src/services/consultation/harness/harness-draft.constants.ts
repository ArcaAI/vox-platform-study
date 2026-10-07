/**
 * `ContextItem.metaData.subType` of the RAW_SUMMARY row the harness document workflow writes — the
 * consultation's final-note DRAFT. Declared once so the writer (`HarnessInternalService`) and the
 * readers that must recognise that row (TASK-1001 wave 4: the resumed-recording re-finalise) cannot
 * disagree about the marker.
 */
export const HARNESS_DRAFT_SUBTYPE = 'HARNESS_DRAFT';

/**
 * TASK-1050 §9.7.6 — `ContextItem.metaData.subType` of the WITHHELD placeholder an outbound-blocked
 * generation leaves behind (no content; `guardrailStatus` WITHHELD). Deliberately NOT the harness
 * draft marker, so the placeholder is never adopted as the consultation's note.
 */
export const GUARDRAIL_WITHHELD_SUBTYPE = 'GUARDRAIL_WITHHELD';
