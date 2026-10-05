import { z } from 'zod';

/**
 * NotePlan v1 and CoverageResult v1 — the wire contract between the gateway, which composes a
 * consultation's note inputs and budget plan, and the harness, which executes it.
 *
 * The shape is pinned by `tests/contracts/note-plan.fixture.json`; the harness parses the same file
 * with its own Pydantic mirror. Every object here is `.strict()` so a field added on one side only
 * fails the parity test instead of being dropped in transit.
 */

export const NOTE_PLAN_SCHEMA = 'hope.note_plan.v1';
export const NOTE_COVERAGE_SCHEMA = 'hope.note_coverage.v1';

/** Block roles in their fixed prompt order (stable prefix first, for KV-cache reuse). */
export const NOTE_BLOCK_ROLES = [
  'pre_summary',
  'encounter_transcript',
  'encounter_ledger',
  'results',
  'attachment_transcript',
  'draft_clinician',
  'draft_ai',
] as const;
export type NoteBlockRole = (typeof NOTE_BLOCK_ROLES)[number];

export const NOTE_PLAN_MODES = ['final', 'section_regen'] as const;
export type NotePlanMode = (typeof NOTE_PLAN_MODES)[number];

export const NOTE_PLAN_STRATEGIES = ['single_pass', 'ledger_prior', 'section_groups', 'ledger_prior+section_groups'] as const;
export type NotePlanStrategy = (typeof NOTE_PLAN_STRATEGIES)[number];

export const NOTE_TOKENIZER_MODES = ['exact', 'estimate'] as const;
export type NoteTokenizerMode = (typeof NOTE_TOKENIZER_MODES)[number];

export const NOTE_COVERAGE_STATUSES = ['complete', 'gaps', 'unchecked'] as const;
export const NOTE_GAP_KINDS = ['missing_fact', 'number_mismatch', 'unresolved_citation', 'ungrounded', 'ledger_unavailable'] as const;

/** Hard ceiling on calls per plan (the harness sequence stride caps section groups at ten). */
export const NOTE_PLAN_MAX_CALLS = 10;

/** Item types that are NEVER a note input — the recap is display-only, the live snapshot is retired. */
export const NOTE_PLAN_EXCLUDED_ITEM_TYPES = ['ENCOUNTER_RECAP', 'LIVE_SOAP_SNAPSHOT'] as const;

/** The non-retryable refusal when the inputs cannot fit the model's window under any strategy. */
export const NOTE_INPUT_EXCEEDS_CONTEXT = 'NOTE_INPUT_EXCEEDS_CONTEXT';

/** Where a composed plan is cached for the harness, and for how long. */
export const NOTE_PLAN_REDIS_PREFIX = 'note-plan:';
export const NOTE_PLAN_TTL_SECONDS = 7200;

/** The `tokenizer.id` recorded when the conservative estimate was used. */
export const NOTE_TOKEN_ESTIMATE_ID = 'estimate:utf8-bytes/2';

const sourceRef = z.object({ contextItemId: z.string(), versionNumber: z.number().int() }).strict();

export const notePlanModelSchema = z
  .object({ slug: z.string(), wireModelId: z.string(), provider: z.string(), contextWindow: z.number().int().positive() })
  .strict();

export const noteReductionSchema = z
  .object({
    kind: z.literal('prior_encounter_to_ledger'),
    encounterSeq: z.number().int(),
    tokensBefore: z.number().int(),
    tokensAfter: z.number().int(),
  })
  .strict();

export const noteBudgetSchema = z
  .object({
    contextWindow: z.number().int().positive(),
    singlePassRatio: z.number(),
    safetyTokens: z.number().int(),
    inputTokens: z.number().int(),
    tokenizer: z.object({ mode: z.enum(NOTE_TOKENIZER_MODES), id: z.string() }).strict(),
    strategy: z.enum(NOTE_PLAN_STRATEGIES),
    reductions: z.array(noteReductionSchema),
  })
  .strict();

export const noteEncounterSourceSchema = z
  .object({
    seq: z.number().int(),
    visitType: z.string(),
    segmentCount: z.number().int(),
    ledgerItemId: z.string().optional(),
    ledgerVersion: z.number().int().optional(),
    rendered: z.enum(['verbatim', 'ledger_cited']),
  })
  .strict();

export const noteDraftSourceSchema = z
  .object({
    contextItemId: z.string(),
    versionNumber: z.number().int(),
    clinicianSections: z.array(z.string()),
    aiSections: z.array(z.string()),
  })
  .strict();

export const noteSourcesSchema = z
  .object({
    encounters: z.array(noteEncounterSourceSchema),
    results: z.array(sourceRef),
    attachmentTranscripts: z.array(sourceRef),
    draft: noteDraftSourceSchema.nullable(),
    preSummary: sourceRef.nullable(),
  })
  .strict();

export const noteBlockSchema = z
  .object({ key: z.string(), role: z.enum(NOTE_BLOCK_ROLES), label: z.string(), content: z.string(), tokens: z.number().int() })
  .strict();

export const noteHeadingSchema = z.object({ key: z.string(), title: z.string() }).strict();

export const noteCallSchema = z
  .object({
    callId: z.string(),
    sectionKeys: z.array(z.string()),
    directive: z.string(),
    maxTokens: z.number().int().positive(),
    promptTokens: z.number().int(),
  })
  .strict();

export const noteNumberSchema = z.object({ value: z.string(), unit: z.string().optional() }).strict();

export const noteCriticalFactSchema = z
  .object({
    factId: z.string(),
    encounterSeq: z.number().int(),
    key: z.string(),
    kind: z.string(),
    anchors: z.array(z.string()),
    numbers: z.array(noteNumberSchema),
    citations: z.array(z.string()),
  })
  .strict();

export const NOTE_SOURCE_KINDS = ['segment', 'result', 'attachment_transcript'] as const;
export type NoteSourceKind = (typeof NOTE_SOURCE_KINDS)[number];

export const noteSourceIdSchema = z.object({ id: z.string(), v: z.number().int(), kind: z.enum(NOTE_SOURCE_KINDS) }).strict();

export const noteCoverageSchema = z
  .object({
    criticalFacts: z.array(noteCriticalFactSchema),
    sourceIds: z.record(z.string(), noteSourceIdSchema),
    repairPasses: z.number().int().min(0).max(1),
  })
  .strict();

export const notePreserveSchema = z
  .object({ contextItemId: z.string(), versionNumber: z.number().int(), sectionKeys: z.array(z.string()) })
  .strict();

export const notePlanV1Schema = z
  .object({
    schema: z.literal(NOTE_PLAN_SCHEMA),
    planId: z.string(),
    consultationId: z.string(),
    tenantId: z.string(),
    inputDigest: z.string(),
    mode: z.enum(NOTE_PLAN_MODES),
    model: notePlanModelSchema,
    budget: noteBudgetSchema,
    sources: noteSourcesSchema,
    /** The system message for the harness-doc lane; the governed lane composes its own from the agent. */
    system: z.string().optional(),
    blocks: z.array(noteBlockSchema),
    headings: z.array(noteHeadingSchema),
    calls: z.array(noteCallSchema).min(1).max(NOTE_PLAN_MAX_CALLS),
    coverage: noteCoverageSchema,
    preserve: notePreserveSchema.nullable(),
  })
  .strict();

export const coverageGapSchema = z
  .object({
    kind: z.enum(NOTE_GAP_KINDS),
    factId: z.string().optional(),
    sectionKey: z.string().optional(),
    segmentIds: z.array(z.string()).optional(),
    /** Free text — encrypted at rest by whoever persists it. */
    detail: z.string(),
  })
  .strict();

export const coverageResultV1Schema = z
  .object({
    schema: z.literal(NOTE_COVERAGE_SCHEMA),
    status: z.enum(NOTE_COVERAGE_STATUSES),
    repairPasses: z.number().int().min(0).max(1),
    criticalFacts: z.object({ total: z.number().int(), present: z.number().int(), missing: z.array(z.string()) }).strict(),
    numbers: z.object({ total: z.number().int(), matched: z.number().int(), unsupported: z.number().int() }).strict(),
    citations: z.object({ total: z.number().int(), resolved: z.number().int(), unresolved: z.array(z.string()) }).strict(),
    groundedness: z.object({ score: z.number(), passed: z.boolean() }).strict().optional(),
    gaps: z.array(coverageGapSchema),
  })
  .strict();

/** What the assemble response hands the harness; the plan itself is fetched by `planId`. */
export const notePlanRefSchema = z.object({ consultationId: z.string(), mode: z.enum(NOTE_PLAN_MODES), planId: z.string() }).strict();

export type NotePlanModel = z.infer<typeof notePlanModelSchema>;
export type NoteReduction = z.infer<typeof noteReductionSchema>;
export type NoteBudget = z.infer<typeof noteBudgetSchema>;
export type NoteEncounterSource = z.infer<typeof noteEncounterSourceSchema>;
export type NoteBlock = z.infer<typeof noteBlockSchema>;
export type NoteHeading = z.infer<typeof noteHeadingSchema>;
export type NoteCall = z.infer<typeof noteCallSchema>;
export type NoteCriticalFact = z.infer<typeof noteCriticalFactSchema>;
export type NoteSourceId = z.infer<typeof noteSourceIdSchema>;
export type NotePlanV1 = z.infer<typeof notePlanV1Schema>;
export type CoverageResultV1 = z.infer<typeof coverageResultV1Schema>;
export type NotePlanRef = z.infer<typeof notePlanRefSchema>;
