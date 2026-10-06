/**
 * TASK-1047 — the prompt-assembly data sections and the block names their placeholders travel
 * under. Pure constants (no imports), shared by `PromptAssemblyService` (call time) and the
 * governed-prompt registry (authoring time), so both render the SAME pointer text and therefore
 * the same piece digests.
 */
/**
 * The per-encounter DATA sections, in the order the USER message presents them, and the
 * variable each one carries.
 *
 * Every one is DATA — transcript, extracted entities, the clinician's notes, attachments, prior
 * records, the live draft — so it travels in the user message inside the spotlighting delimiters
 * the platform rules describe, and never in the system message. A governed body that names one
 * of these variables inline (`Transcript:\n{{transcript}}`, the seeded shape) renders a POINTER
 * to the section instead of the value (TASK-1047 FC-1: the composer renders every placeholder as a
 * pointer; `blockAliases` keeps these sections' established names): the instruction stays stable
 * for the prefix cache, and transcript text can never sit at instruction trust.
 *
 * TASK-1047 D9 — the TRANSCRIPT is last: the stable context comes first so an engine's prefix
 * cache reuses it, and the text that changes most sits nearest the generation point.
 */
export const DATA_SECTIONS: ReadonlyArray<{ key: string; label: string; variable: string }> = [
  { key: 'ner_entities', label: 'RECOGNIZED CLINICAL ENTITIES (from NER)', variable: 'ner_entities' },
  { key: 'clinician_notes', label: 'CLINICIAN NOTES (case / work notes)', variable: 'clinician_notes' },
  { key: 'attachments', label: 'ATTACHMENTS (lab / exam results)', variable: 'attachments' },
  { key: 'case_notes', label: 'CASE NOTES', variable: 'case_notes' },
  { key: 'recent_vitals', label: 'RECENT VITALS', variable: 'recent_vitals' },
  { key: 'previous_case_notes_summary', label: 'PREVIOUS CASE NOTES SUMMARY', variable: 'previous_case_notes_summary' },
  { key: 'test_results', label: 'TEST RESULTS', variable: 'formatted_test_results' },
  { key: 'same_day_prequel_summary', label: 'SAME-DAY EARLIER VISIT(S)', variable: 'same_day_prequel_summary' },
  { key: 'doctor_highlights', label: 'DOCTOR HIGHLIGHTS (clinician-flagged spans)', variable: 'doctor_highlights' },
  { key: 'prior_visit_summary', label: 'PRIOR VISIT SUMMARY', variable: 'prior_visit_summary' },
  { key: 'prior_draft', label: 'PRIOR DRAFT (running SOAP note from the live session — STAGE 1 SCRATCHPAD)', variable: 'pre_summary_text' },
  { key: 'transcript', label: 'TRANSCRIPT', variable: 'transcript' },
];

/** v1 names that carry the same value as a data section, so they point at it too. */
export const DATA_SECTION_ALIASES: Readonly<Record<string, string>> = {
  safe_vitals: 'recent_vitals',
  formatted_previous_visits: 'previous_case_notes_summary',
};

/**
 * TASK-1047 FC-1 — the placeholder spellings a scope admits for one bare name. `blockAliases` is
 * keyed by placeholder PATH, so each spelling a governed body may use is aliased.
 */
export const PLACEHOLDER_PREFIXES: readonly string[] = ['', 'context.', 'trigger.context.', 'variables.'];

/**
 * TASK-1047 FC-1 — placeholder path → block name for this assembly's data sections (and v1's two
 * names for the same values), in every spelling a scope admits. STATIC: it depends on nothing but
 * this table, so a governed body renders the same system message for every encounter, and the
 * authoring-time digest (FC-3) can be computed with the very same map.
 */
export const PROMPT_ASSEMBLY_BLOCK_ALIASES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    [...DATA_SECTIONS.map((section) => [section.variable, section.key] as const), ...Object.entries(DATA_SECTION_ALIASES)].flatMap(([name, block]) =>
      PLACEHOLDER_PREFIXES.map((prefix) => [`${prefix}${name}`, block] as const),
    ),
  ),
);
