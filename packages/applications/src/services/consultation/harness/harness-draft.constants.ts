/**
 * `ContextItem.metaData.subType` of the RAW_SUMMARY row the harness document workflow writes — the
 * consultation's final-note DRAFT. Declared once so the writer (`HarnessInternalService`) and the
 * readers that must recognise that row (TASK-1001 wave 4: the resumed-recording re-finalise) cannot
 * disagree about the marker.
 */
export const HARNESS_DRAFT_SUBTYPE = 'HARNESS_DRAFT';
