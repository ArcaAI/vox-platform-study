/**
 * PromptAssemblyService
 *
 * Assembles a complete TEXT v2 payload by:
 * 1. Resolving the prompt template via PromptResolutionService
 * 2. Loading template content + hyperparameters + JSON schema from DB
 * 3. Composing the messages through the ONE composer (`composeMessages`): the platform rules,
 *    the governed body rendered over the `context.*` namespace the tenant's context schema clone
 *    declares, the output-language step and the platform guidance in the SYSTEM message; every
 *    per-encounter data section, delimiter-wrapped, in the USER message
 * 4. Building the final payload with all parameters for TEXT v2
 */

import { BadRequestException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PromptResolutionService, PromptResolutionTier, type PromptTypeSelector } from './prompt-resolution.service';
import { PRE_SUMMARY_TEMPLATE_VARIABLES, buildPreSummaryVariables } from './pre-summary-variables';
import {
  PromptTemplateRepository,
  DnaWritingStyleReportRepository,
  DepartmentRepository,
  ConsultationContextSchemaRepository,
  ConsultationContextSchemaVersionRepository,
} from '@arcaai/domains';
// The ONE composer and the ONE prompt grammar, shared with the agent lanes and the harness.
import {
  PromptCompositionEmptyError,
  PromptTemplateSyntaxError,
  PromptVariableUnresolvedError,
  buildPromptScope,
  composeMessages,
  platformRules,
  resolvedPromptVariableDeclarations,
  templateReferences,
  type ComposableResolvedPrompt,
  type PromptScopeVariableDeclaration,
  type ComposeDataBlock,
  type ComposedDataBlock,
  type ComposedMessages,
  type SystemGovernance,
} from '@arcaai/workflow-contract';
import type { GovernedPieceInput } from '../../governed-prompt/IGovernedPromptRegistry';
import { platformPiecesOf, type OutputContractPart } from '../../text-request/system-governance';
import {
  DNA_REDACTION_GUIDANCE,
  DNA_STYLE_GUIDANCE,
  STYLE_REFERENCE_BLOCK,
  STYLE_REFERENCE_EXEMPLARS_GUIDANCE,
  styleReferenceContent,
} from './style-reference';
// TASK-890 §3.4 — the legacy bridge: the SYSTEM schema that DECLARES the v1 prompt vocabulary,
// cloned into every tenant by the reference set. The slug is imported, never re-typed.
import { LEGACY_CONTEXT_SCHEMA_SLUG, payloadSchemaFromDefinition } from '../../consultation-context-schema/context-schema-definition';
import { parsePromptVariableDeclarations } from '../../prompt-management/dto/prompt-variable-declaration.dto';
import { SecretsService } from '../../baseServices/_meta/secrets/SecretsService';
import { IGateEditExemplarRetriever } from '../../gate-edit-mining/IGateEditExemplarRetriever';
import { parseLanguageTag, summaryLanguageName } from '../consultation/summary-language';
import { IActiveUserContext } from '../../../interfaces';

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
const DATA_SECTIONS: ReadonlyArray<{ key: string; label: string; variable: string }> = [
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

/** The department-scoped DNA style slots a governed body may name (one style per doctor fills them all). */
const DNA_STYLE_VARIABLE_KEYS: readonly string[] = [
  'style_DNA_doctor_department_surgery',
  'style_DNA_doctor_department_medicine',
  'style_DNA_doctor_department_neurology',
  'style_DNA_doctor_department_orthopedics',
  'style_DNA_doctor_department_hematology',
  'style_DNA_doctor_department_rheumatology',
  'style_DNA_doctor_department_dermatology',
  'style_DNA_doctor_department_dietetics',
  'style_DNA_doctor_department_nephrology',
  'style_DNA_doctor_department_surgical_oncology',
  'style_DNA_doctor_department_breast_endocrine',
];

/** v1 names that carry the same value as a data section, so they point at it too. */
const DATA_SECTION_ALIASES: Readonly<Record<string, string>> = {
  safe_vitals: 'recent_vitals',
  formatted_previous_visits: 'previous_case_notes_summary',
};

/**
 * Every name this assembly OWNS — the ones its value builders populate. A body that reads one
 * without a `default("…")` when this encounter has no value renders it EMPTY; a body reading any
 * OTHER name that nothing supplies is refused by name (`PROMPT_VARIABLE_UNRESOLVED`).
 */
const OWNED_NAMES: ReadonlySet<string> = new Set([
  'conversation_language',
  'case_notes',
  'dna_redaction_rules_text',
  'dna_style_text',
  ...DATA_SECTIONS.map((section) => section.variable),
  ...PRE_SUMMARY_TEMPLATE_VARIABLES,
  ...DNA_STYLE_VARIABLE_KEYS,
  // The §8.2 names a workflow trigger context carries (see `noteContextAliases`).
  'language',
  'formatted_vitals',
  'chief_complaint',
]);

/** A placeholder path with the namespace prefixes the scope admits stripped: `trigger.context.x` / `context.x` → `x`. */
function bareName(path: string): string {
  return path.replace(/^trigger\.context\./, '').replace(/^context\./, '');
}

/**
 * TASK-1047 FC-1 — the placeholder spellings a scope admits for one bare name. `blockAliases` is
 * keyed by placeholder PATH, so each spelling a governed body may use is aliased.
 */
const PLACEHOLDER_PREFIXES: readonly string[] = ['', 'context.', 'trigger.context.', 'variables.'];

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


/**
 * How many approved notes are shown as style examples.
 *
 * Small on purpose: each exemplar is a whole clinical note, so the block costs
 * real prompt budget, and few-shot returns diminish quickly. The mining service
 * caps this independently — this is the prompt side's own ceiling.
 */
const FEW_SHOT_EXEMPLAR_LIMIT = 3;

/**
 * The non-authoritative framing for carried prior-visit content (F-18).
 *
 * Platform-authored guidance, so it sits in the SYSTEM message — the prior note itself is the
 * `prior_visit_summary` data section. The wording is the whole safety mechanism of the feature:
 * carry-forward reproduces the copy-paste / cloned-note failure mode (stale or unverified content
 * propagating into a new encounter), so the section must read as a REFERENCE the model has to
 * re-confirm, never as this visit's findings. The exam/medication clause is explicit because
 * those are precisely the fields a carried note most plausibly — and most dangerously — fills in
 * without current evidence.
 */
const PRIOR_VISIT_SUMMARY_GUIDANCE = [
  'PRIOR VISIT SUMMARY — REFERENCE ONLY, NOT CURRENT-VISIT EVIDENCE.',
  "The PRIOR VISIT SUMMARY data section is this patient's documentation from a PREVIOUS encounter. It is a NON-AUTHORITATIVE prior:",
  'use it only for continuity (known history, ongoing problems, prior plan). Every fact you take from it must be',
  're-confirmed against the CURRENT transcript before you restate it; if the current transcript does not support it,',
  'leave it out rather than carrying it forward. Never populate examination findings, vitals, results, or medication',
  'statements from this section without current-visit evidence.',
].join('\n');


/**
 * The platform guidance that accompanies a composed note plan's blocks (system message).
 *
 * It states how the record is laid out and which source wins, so a multi-encounter consultation is
 * written from every encounter: later encounters override earlier ones on the same point, a
 * clinician's edited wording is kept, and an earlier AI draft is never a source on its own.
 */
export const NOTE_INPUTS_GUIDANCE = [
  "NOTE INPUTS — the data sections below are this consultation's complete record, oldest first:",
  'background from earlier visits (reference only); each earlier encounter as its transcript, or as its fact ledger with the transcript lines that ledger cites;',
  'results [R<n>] and uploaded-audio transcripts [A<n>]; then the latest encounter in full. Transcript lines are labelled [S<n> E<encounter> <speaker> mm:ss].',
  'Every encounter belongs in the note: carry every allergy (with its reaction), current medication (with its dose), abnormal vital or result, order and follow-up from EVERY encounter into the note, each with its label; a fact from an earlier encounter stays unless a later encounter changes it. Where a later encounter changes something an earlier one stated (a dose, a diagnosis, the plan), the later encounter wins.',
  'Clinician-edited sections are the clinician’s own wording: keep their meaning. The previous AI draft is a draft to check against the sources, never a source on its own.',
  'Cite every statement with the labels of the lines it comes from.',
].join('\n');

/**
 * Stable 32-bit fingerprint of the exemplar set, used only to VERSION the
 * few-shot block. It lets a cached prefix be attributed to a known exemplar set
 * (and makes a set change visible in logs) without embedding row ids — which
 * would leak which encounters were mined.
 */
function fingerprintExemplarSet(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * The bare names an instruction references, in the ONE grammar, with the namespace prefixes the
 * scope admits stripped: `{{safe_age}}`, `{{context.safe_age}}` and `{{trigger.context.safe_age}}`
 * all name `safe_age`.
 */
function referencedNames(contents: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const content of contents) {
    for (const reference of templateReferences(content)) {
      names.add(bareName(reference.path));
    }
  }
  return names;
}

/** Every body an instruction renders — the fragments of a composite, else the one body. */
function instructionContents(resolvedPrompt: ComposableResolvedPrompt): string[] {
  if (!resolvedPrompt) return [];
  if (resolvedPrompt.source === 'composite') {
    return (Array.isArray(resolvedPrompt.fragments) ? resolvedPrompt.fragments : []).map((fragment) => fragment.content);
  }
  return [resolvedPrompt.content];
}

/**
 * Does this instruction reference any of v1's nine pre-summary names, in the ONE grammar?
 *
 * The gate exists so a SUMMARY template never pays for the department lookup the nine need.
 */
function referencesPreSummaryVariables(referenced: ReadonlySet<string>): boolean {
  return PRE_SUMMARY_TEMPLATE_VARIABLES.some((name) => referenced.has(name));
}

/**
 * Serialises NER entities into a compact, LLM-friendly block.
 *
 * One line per entity:
 *   `- <label> (<TYPE>) [umls:..; snomed:..; rxnorm:..; icd:..; loinc:..] @<start>-<end>`
 *
 * The label prefers the normalized form when available. Codes and offsets are
 * only emitted when present, keeping the block dense and deterministic.
 *
 * The ontology codes (umls/snomed/rxnorm/icd/loinc) are READ
 * here but WRITTEN nowhere until the SOTA Theme C clinical NER + ontology linker
 * lands; today the code set is permanently empty. The groundedness
 * guard below therefore emits an explicit "no codes present" note when the whole
 * entity set is un-coded, so the block never reads as if coding was attempted.
 * The guard disengages automatically once the linker starts populating codes.
 */
// This note is injected into the clinical LLM prompt on EVERY
// NER-bearing summary today (the code set is permanently empty), so it must be
// clinically NEUTRAL: no internal jargon or ticket ids (which the model could
// echo into a patient's summary) — those stay in the doc comment above
// (code only), never in the prompt string.
const NER_NO_ONTOLOGY_CODES_NOTE = '(no standardized codes assigned)';

function serializeNerEntities(entities: NerEntityForPrompt[]): string {
  if (!entities?.length) {
    return '';
  }

  // Groundedness guard — does ANY entity carry an ontology code?
  const hasAnyOntologyCode = entities.some(
    (entity) => entity.umlsCui || entity.snomedCode || entity.rxnormCode || entity.icdCode || entity.loincCode,
  );

  const lines = entities.map((entity) => {
    const label = entity.normalizedText && entity.normalizedText.trim().length > 0 ? entity.normalizedText : entity.text;

    const codeParts: string[] = [];
    if (entity.umlsCui) codeParts.push(`umls:${entity.umlsCui}`);
    if (entity.snomedCode) codeParts.push(`snomed:${entity.snomedCode}`);
    if (entity.rxnormCode) codeParts.push(`rxnorm:${entity.rxnormCode}`);
    if (entity.icdCode) codeParts.push(`icd:${entity.icdCode}`);
    if (entity.loincCode) codeParts.push(`loinc:${entity.loincCode}`);
    const codes = codeParts.length > 0 ? ` [${codeParts.join('; ')}]` : '';

    const span = entity.startOffset != null && entity.endOffset != null ? ` @${entity.startOffset}-${entity.endOffset}` : '';

    return `- ${label} (${entity.type})${codes}${span}`;
  });

  // Make "no codes present" EXPLICIT rather than silently emitting un-coded lines
  // that could read as if ontology coding had been performed.
  if (!hasAnyOntologyCode) {
    lines.push(NER_NO_ONTOLOGY_CODES_NOTE);
  }

  return lines.join('\n');
}

/**
 * Serialises a list of free-text items (clinician notes / attachment contents)
 * into a compact block — one entry per line, blanks dropped.
 */
function serializeTextBlock(items?: string[]): string {
  if (!items?.length) {
    return '';
  }
  return items
    .map((item) => item?.trim())
    .filter((item): item is string => !!item)
    .join('\n');
}

// ============================================================================
// Types
// ============================================================================

/**
 * A NER entity flattened for prompt injection.
 * Mapped from NamedEntityEntity by the SummaryProcessor; codes/offsets optional.
 */
export interface NerEntityForPrompt {
  text: string;
  type: string;
  normalizedText?: string | null;
  umlsCui?: string | null;
  snomedCode?: string | null;
  rxnormCode?: string | null;
  icdCode?: string | null;
  loincCode?: string | null;
  startOffset?: number | null;
  endOffset?: number | null;
}

export interface PromptAssemblyParams {
  /**
   * The calling tenant. Optional: callers running inside a CLS context (API request, harness
   * worker, BullMQ processor) may omit it and the tenant is read from CLS.
   */
  tenantId?: string;
  departmentId?: string;
  promptType?: PromptTypeSelector;
  /**
   * Which pre-summary prompt FAMILY to resolve when
   * `promptType === 'pre-summary'`. `'v1'` (the resolver default) is the
   * v1-parity body compat requires (RF-1 wire contract, never set by native
   * callers); `'dept-free'` is the native-only fork with no
   * `{current_department}` / `{visit_type}` placeholder. Ignored for every
   * other `promptType`.
   */
  preSummaryVariant?: 'v1' | 'dept-free';
  /**
   * The consultation's visit type, rendered into v1's `{visit_type}` placeholder
   * on a pre-summary body.
   *
   * Supplied by the caller because assembly cannot see the consultation. Native
   * callers pass the LABEL of the visit type `VisitTypeService.forConsultation`
   * derives from the parent link — it used to be a `parentConsultationId ?
   * 'revisit': 'new-visit'` literal at each call site. Absent ⇒ v1's own
   * default, `'Medical examination'`.
   */
  visitType?: string;
  transcript: string;
  conversationLanguage: string;
  dnaStyleId?: string;
  /**
   * TASK-1034 R3 — the doctor's redaction rules as a human-readable bullet list
   * (`renderDnaRedactionRulesText`), already GATED by the caller on the effective DNA
   * redaction decision. Advisory: the deterministic post-generation pass stays the guarantee.
   */
  dnaRedactionRulesText?: string;
  /** A prior draft, placed only where the governed body names `pre_summary_text`. */
  preSummaryText?: string;
  /**
   * Pin the resolver's agent tier to the session's agent
   * (see `PromptResolutionParams.pinnedAgentId`). Passed straight through.
   */
  pinnedAgentId?: string;
  /**
   * The patient's most authoritative summary from the PARENT consultation of a
   * re-visit (F-18). Supplied only when the assigned graph's `carryForward` binding is
   * on — the producer (`HarnessInternalService.assemble`) resolves that knob and
   * omits this field entirely when it is off, so the default-off posture holds
   * even if a future caller forgets the gate.
   *
   * Injected as an explicitly NON-AUTHORITATIVE prior (see
   * {@link PRIOR_VISIT_SUMMARY_PREAMBLE}), never as fact.
   */
  priorVisitSummary?: string;
  explicitTemplate?: string;
  /** The requesting doctor's preferred prompt template id. */
  preferredPromptTemplateId?: string | null;
  /**
   * Clinical NER entities for the consultation transcript.
   * Serialised into the {ner_entities} variable and/or appended to the prompt
   * so NER output actually reaches the LLM.
   */
  nerEntities?: NerEntityForPrompt[];
  /**
   * The doctor's case-notes / work-notes for the consultation
   * (each entry already labeled by the caller, e.g. `[case note] …`). Serialised
   * into {clinician_notes} and/or appended so they reach the authoritative SOAP.
   */
  clinicianNotes?: string[];
  /**
   * HISTORICAL case-note records this prompt documents FROM, one entry per note.
   *
   * Distinct from {@link clinicianNotes}, which is what the clinician wrote DURING this
   * encounter as supporting context for a transcript. These are the records the pre-summary
   * chain summarises, and they used to arrive as `transcript` — so the model was told that
   * text from previous encounters was what was said in this one. They now arrive under their
   * own `case_notes` section, and the pre-summary caller passes an EMPTY transcript, which is
   * the truth: that chain has no recording.
   */
  caseNotes?: string[];
  /**
   * The vitals the clinic MEASURED and the client sent at `open`, already rendered as one line
   * by the shared reader (`context/client-clinical-context.ts`).
   *
   * Rendered into v1's `{{context.safe_vitals}}` where a body declares it, and appended as a
   * `recent_vitals` data block where none does. Absent ⇒ v1's own `Not available`.
   *
   * (Until the client could state a context payload at `open`, the v2 data model held no vitals
   * and no prior-visit text at all, and these two fell through to v1's defaults on every prompt.
   * They are a source now, so the defaults are no longer the honest answer.)
   */
  vitals?: string;
  /**
   * The prior-visit history the client sent at `open`, newest first and bounded, as rendered by
   * the same shared reader. Feeds `{{context.formatted_previous_visits}}` and the
   * `previous_case_notes_summary` data block. Absent ⇒ v1's own `''`.
   */
  previousVisits?: string;
  /**
   * TASK-1020 — the dated notes of the patient's EARLIER visits TODAY (same patient, same day,
   * chained by `parentConsultationId`), as rendered by `harness/same-day-prequel.ts`. Its own
   * variable, `same_day_prequel_summary`, independent of the carry-forward {@link priorVisitSummary}:
   * a same-day return is produced whenever a same-day ancestor exists, not on a graph binding.
   * Rendered in place where a body inlines it, else appended as a delimiter-wrapped data block.
   * Absent / blank ⇒ `''` and the prompt is byte-identical.
   */
  sameDayPrequelSummary?: string;
  /**
   * TASK-1020 — the client's `investigations`, one line per result, as rendered by the shared
   * reader. Feeds v1's `{{context.formatted_test_results}}` (which had no source until now) and a
   * `test_results` data block where a body does not inline it. Absent ⇒ v1's own `''`.
   */
  testResults?: string;
  /**
   * Uploaded lab/exam attachment contents (extracted text when
   * available, else the filename label). Serialised into {attachments} and/or
   * appended to the prompt.
   */
  attachments?: string[];
  /**
   * The doctor's manual highlight spans for the
   * consultation (each entry already labeled by the caller, e.g. `[highlight] …`).
   * Serialised into {doctor_highlights} and/or appended so the clinician-flagged
   * spans reach the authoritative SOAP. A SEPARATE concern from NER entities.
   */
  highlights?: string[];
  /**
   * The Prompt Inspector's override: compose THIS instruction (a named agent's frozen one) instead
   * of the resolved one. The resolver still runs, for the template's metadata (hyperparameters,
   * output schema). Never set on a generation path.
   */
  instructionOverride?: { resolvedPrompt: ComposableResolvedPrompt; variables?: Record<string, unknown> };
  /**
   * A composed note plan's blocks, in the plan's fixed order. When present they ARE the user
   * message — the per-encounter data sections, the few-shot style block and the live draft are not
   * added — so the assembled prompt is byte-identical to what the harness sends for the plan.
   */
  noteInputBlocks?: ReadonlyArray<{ key: string; label: string; content: string }>;
}

export interface AssembledPrompt {
  userPrompt: string;
  systemPrompt: string;
  hyperparameters: Record<string, number>;
  responseFormat: { type: string; json_schema: Record<string, unknown>; strict: boolean } | null;
  resolvedFrom: PromptResolutionTier;
  /**
   * The prompt registry id that was actually resolved/used.
   * Optional so existing inline AssembledPrompt literals remain valid; the real
   * PromptAssemblyService.assemble() always populates it from the resolver.
   */
  promptId?: string;
  /**
   * The governed PromptVersion number whose CONTENT was actually assembled into
   * the body — the agent pin / `approvedVersionNumber` snapshot, NOT the mutable
   * template row's `currentVersionNumber`. Callers should surface THIS as prompt
   * provenance so the recorded version matches what the LLM actually saw
   * (F-01/F-02). Absent only when no snapshot resolved (legacy transcript-only
   * fallback).
   */
  resolvedVersionNumber?: number | null;
  /** Selected fragment keys of a composite instruction, in order (empty for a single body). */
  selected?: string[];
  /** Excluded fragment keys and why — KEYS ONLY, never a body or a condition. */
  excluded?: { key: string; reason: string }[];
  /** One entry per data section the user message carries, in order. */
  blocks?: ComposedDataBlock[];
  /**
   * TASK-1047 FC-2 — the system message as governed pieces, from the composer (absent until the
   * composer reports it). Forwarded as the egress hint; never sent to TEXT by itself.
   */
  governance?: SystemGovernance;
  /** TASK-1047 FC-3 — the PLATFORM / LANGUAGE / CONTRACT pieces this assembly emitted, for registration. */
  platformPieces?: GovernedPieceInput[];
}

/**
 * The §8.2 names a workflow trigger context carries that this assembly knows by another name —
 * so an agent instruction binding `trigger.context.language` / `formatted_vitals` resolves here
 * exactly as on the workflow lanes. `chief_complaint` is the declared empty placeholder the
 * realtime lane publishes too. A name the assembly already binds is never overwritten.
 */
function noteContextAliases(rendered: Readonly<Record<string, string>>, params: PromptAssemblyParams): Record<string, string> {
  const aliases: Record<string, string> = {
    language: params.conversationLanguage,
    formatted_vitals: rendered.safe_vitals ?? (rendered.recent_vitals || 'Not available'),
    chief_complaint: '',
  };
  return Object.fromEntries(Object.entries(aliases).filter(([name]) => !(name in rendered)));
}

/** An agent's `{ path }` bindings as placeholders, so the names they read count as referenced. */
function bindingPaths(variables: Readonly<Record<string, unknown>>): string[] {
  return Object.values(variables)
    .map((binding) =>
      binding !== null && typeof binding === 'object' && typeof (binding as { path?: unknown }).path === 'string'
        ? `{{${(binding as { path: string }).path}}}`
        : null,
    )
    .filter((placeholder): placeholder is string => placeholder !== null);
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class PromptAssemblyService {
  private readonly logger = new Logger(PromptAssemblyService.name);

  constructor(
    private readonly promptResolutionService: PromptResolutionService,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly dnaWritingStyleRepository: DnaWritingStyleReportRepository,
    @Optional() @Inject(ClsService) private readonly cls?: ClsService<IActiveUserContext>,
    // The gate-edit learning loop's READ half. Optional and
    // trailing for the same reason as the one above: absent ⇒ zero-shot, which
    // is exactly the pre-B6 prompt.
    @Optional() @Inject(IGateEditExemplarRetriever) private readonly exemplarRetriever?: IGateEditExemplarRetriever,
    // DNA writing-style decryption. The styleText column is
    // Vault-Transit ciphertext (plaintext dropped in Phase 6), and the generic
    // repository findById never decrypts — so without a SecretsService the style
    // is silently never injected. @Global SecretsModule supplies this in prod;
    // @Optional + trailing so existing positional test fixtures keep their arity
    // (absent ⇒ legacy non-decrypting read, i.e. the prior latent no-op).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // v1 `{current_department}` resolution: a pre-summary body
    // renders the department NAME, but callers only carry `departmentId`.
    // @Optional + trailing for the same reason as the three above (positional
    // test fixtures); absent ⇒ v1's `'General'` default, never a literal brace.
    @Optional() @Inject(DepartmentRepository) private readonly departmentRepository?: DepartmentRepository,
    // TASK-890 §3.4 — the TENANT's clone of the `consultation_legacy_v1` bridge schema, which
    // DECLARES the prompt vocabulary this service populates. Read by slug under the caller's
    // tenant: context schemas are CONTENT (§1.5), so there is no SYSTEM tier to widen to and
    // the SYSTEM row is deliberately never read here. @Optional + trailing so every positional
    // fixture keeps its arity; absent ⇒ the code-owned builders alone, which is the transition
    // behaviour until L13 backfills every tenant.
    @Optional() @Inject(ConsultationContextSchemaRepository) private readonly contextSchemaRepository?: ConsultationContextSchemaRepository,
    @Optional()
    @Inject(ConsultationContextSchemaVersionRepository)
    private readonly contextSchemaVersionRepository?: ConsultationContextSchemaVersionRepository,
  ) {}

  /**
   * The few-shot style section, or `null` when there is nothing to add.
   *
   * Three properties this method must never lose:
   *
   *  * **Silent degradation.** No retriever, no tenant, no rows, or a throwing
   *    store all return `null`. A learning-loop outage must not become a
   *    generation outage.
   *  * **Redacted text only.** `redactedAfter` is the sole field read; it is the
   *    only one the mining store guarantees is PHI-free.
   *  * **Framed as style, not history.** The notes belong to OTHER encounters,
   *    so the guidance (system message) and the section label both say so — an
   *    unlabelled block is a fabrication vector, since the model would be free to
   *    read another patient's findings as this patient's.
   */
  private async buildFewShotExemplars(params: PromptAssemblyParams): Promise<{ version: string; text: string } | null> {
    if (!this.exemplarRetriever) return null;

    const tenantId = params.tenantId ?? this.cls?.get('tenantId');
    if (!tenantId) return null;

    let rows;
    try {
      rows = await this.exemplarRetriever.retrieveExemplars({
        tenantId,
        departmentId: params.departmentId ?? null,
        limit: FEW_SHOT_EXEMPLAR_LIMIT,
      });
    } catch (error) {
      this.logger.warn(
        `Gate-edit exemplar retrieval failed; falling back to a zero-shot prompt: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }

    const snippets = (rows ?? [])
      .map((row) => row?.redactedAfter?.trim())
      .filter((snippet): snippet is string => !!snippet)
      .slice(0, FEW_SHOT_EXEMPLAR_LIMIT);

    if (snippets.length === 0) return null;

    // NUL joiner: a separator that cannot occur inside a note, so two different
    // exemplar SETS can never fingerprint identically by concatenation.
    // Written as the ESCAPE, never a literal NUL byte — a raw NUL makes this
    // whole file `binary` to grep/ripgrep, which silently drops it from every
    // tree-wide search and hides the few-shot code from anyone auditing it.
    const version = fingerprintExemplarSet(snippets.join('\u0000'));
    return { version, text: snippets.join('\n\n- - -\n\n') };
  }

  async assemble(params: PromptAssemblyParams): Promise<AssembledPrompt> {
    const resolved = await this.promptResolutionService.resolve({
      departmentId: params.departmentId,
      // The pre-summary chain has NO department axis and cannot derive the
      // tenant from a Department row, so it must be told explicitly — otherwise
      // a consultation with no department skips the tenant tier and lands on the
      // SYSTEM default, or fails closed with a 503. CLS is the fallback for
      // callers already running inside a request/worker scope.
      tenantId: params.tenantId ?? this.cls?.get('tenantId'),
      promptType: params.promptType,
      // The visit-type axis, stated explicitly. This is what lets the
      // PRE-SUMMARY chain see a visit type at all — its `promptType` is the
      // phase, so before this the axis could not reach the resolver.
      preSummaryVariant: params.preSummaryVariant,
      explicitTemplate: params.explicitTemplate,
      preferredPromptTemplateId: params.preferredPromptTemplateId,
      // Finalize pins the LIVE session's agent.
      pinnedAgentId: params.pinnedAgentId,
    });

    const template = resolved.promptId ? await this.promptTemplateRepository.findById(resolved.promptId) : null;

    // The GOVERNED snapshot from the resolver is authoritative for the prompt
    // BODY (F-01/F-02): a DepartmentAgent pinned to v3, or an APPROVED template
    // edited without re-approval, must NOT change what the LLM sees. The template
    // row is fetched ONLY for metaData (promptConfig / hyperparameters /
    // outputSchema) below — NEVER for the body. `template.content` survives as a
    // legacy/defensive fallback, reachable only when the resolver could not
    // surface a snapshot (legacy data with no version rows).
    //
    // An agent tier that resolved a COMPOSITE instruction hands over the frozen composite itself:
    // every fragment is selected over the render scope, so a conditional fragment applies here
    // exactly as it does on the agent lanes. The primary template is only its governance pointer.
    const bodyTemplate = resolved.content ?? template?.content ?? null;
    const override = params.instructionOverride;
    const instruction: ComposableResolvedPrompt = override
      ? override.resolvedPrompt
      : (resolved.resolvedPrompt ?? (bodyTemplate ? { source: 'inline', content: bodyTemplate } : null));
    const agentVariables = override ? (override.variables ?? {}) : resolved.resolvedPrompt ? (resolved.promptVariables ?? {}) : {};
    // TASK-1036 OD-10 — the declarations the instruction carries: frozen on an agent's resolved
    // prompt, else the governed template row's own. An absent OPTIONAL one renders `""`.
    const variableDeclarations: readonly PromptScopeVariableDeclaration[] =
      override || resolved.resolvedPrompt
        ? resolvedPromptVariableDeclarations(instruction)
        : parsePromptVariableDeclarations((template as { variables?: unknown } | null)?.variables);

    const referenced = referencedNames([...instructionContents(instruction), ...bindingPaths(agentVariables)]);
    const values = await this.buildVariables(params, referenced);
    // The doctor's style and rules travel in STYLE REFERENCE only where the body does not place them
    // itself; a body that names a slot carries the value in that slot's own block (no duplicate).
    const dnaPlacedByBody = referenced.has('dna_style_text') || this.getDnaVariableKeys().some((key) => referenced.has(key));
    const rulesPlacedByBody = referenced.has('dna_redaction_rules_text');


    // DATA → the USER message. Each section is wrapped in the spotlighting delimiters the
    // platform rules describe (F-03); a section with nothing in it is skipped by the composer.
    // A composed note plan replaces every per-encounter section with its own blocks.
    const noteInputs = params.noteInputBlocks;
    const fewShot = noteInputs ? null : await this.buildFewShotExemplars(params);
    const styleReference = noteInputs
      ? null
      : styleReferenceContent({
          style: dnaPlacedByBody ? null : values.dna_style_text,
          rules: rulesPlacedByBody ? null : values.dna_redaction_rules_text,
          exemplars: fewShot,
        });
    const dataBlocks: ComposeDataBlock[] = noteInputs
      ? noteInputs.map((block) => ({ key: block.key, label: block.label, content: block.content }))
      : [
          // Placed first, so the engine's prefix cache still hits across flushes for one doctor and exemplar set.
          ...(styleReference ? [{ key: STYLE_REFERENCE_BLOCK.key, label: STYLE_REFERENCE_BLOCK.label, content: styleReference }] : []),
          ...DATA_SECTIONS.map((section) => ({ key: section.key, label: section.label, content: values[section.variable] ?? null })),
        ];

    // TASK-1047 FC-1 — the instruction renders a POINTER for every placeholder (the composer's job);
    // the STATIC `PROMPT_ASSEMBLY_BLOCK_ALIASES` keep each data section's established block name, so
    // a body naming `{{transcript}}` points at the TRANSCRIPT section rather than at a second copy of
    // it — and the system message depends on the template alone, never on which sections this
    // encounter happens to fill (a skipped section's slot carries its own absence value instead).
    // A composed note plan IS the user message, so its data variables are bound EMPTY: the plan's
    // blocks carry the record, and the system message is byte-identical to the non-plan one.
    const rendered: Record<string, string> = { ...values };
    if (noteInputs) {
      for (const section of DATA_SECTIONS) if (section.variable in values) rendered[section.variable] = '';
      for (const alias of Object.keys(DATA_SECTION_ALIASES)) if (alias in rendered) rendered[alias] = '';
    }
    // GUIDANCE → the tail of the SYSTEM message: STATIC, keyed, platform-authored instructions about
    // the data sections (TASK-1047 D1 — never a runtime value; the doctor's style and rules are in
    // the STYLE REFERENCE section, and only what to do with them is said here).
    const contractParts: OutputContractPart[] = [
      fewShot ? { key: 'style-reference-exemplars', text: STYLE_REFERENCE_EXEMPLARS_GUIDANCE } : null,
      noteInputs ? { key: 'note-inputs', text: NOTE_INPUTS_GUIDANCE } : null,
      values.prior_visit_summary || noteInputs?.some((block) => block.key === 'prior_visit_summary')
        ? { key: 'prior-visit-summary', text: PRIOR_VISIT_SUMMARY_GUIDANCE }
        : null,
      values.dna_style_text && !dnaPlacedByBody ? { key: 'dna-style', text: DNA_STYLE_GUIDANCE } : null,
      values.dna_redaction_rules_text && !rulesPlacedByBody ? { key: 'dna-redaction-rules', text: DNA_REDACTION_GUIDANCE } : null,
    ].filter((part): part is OutputContractPart => part !== null);

    // The note's OUTPUT language — the platform default every caller passes — stated once, as the
    // composer's fixed sentence.
    const languageName = summaryLanguageName(parseLanguageTag(params.conversationLanguage));
    const composed = await this.composeOrRefuse(params, resolved.promptId ?? null, {
      instruction,
      rendered,
      agentVariables,
      variableDeclarations,
      outputContractParts: contractParts,
      blockAliases: PROMPT_ASSEMBLY_BLOCK_ALIASES,
      outputLanguage: languageName ? { name: languageName } : null,
      dataBlocks,
    });

    const promptConfig = this.extractPromptConfig(template);
    const hyperparameters = promptConfig?.hyperparameters ?? {};
    const outputSchema = promptConfig?.outputSchema ?? null;

    const responseFormat = outputSchema ? { type: 'json_schema' as const, json_schema: outputSchema, strict: true } : null;

    this.logger.debug({
      message: 'Prompt assembled',
      resolvedFrom: resolved.resolvedFrom,
      templateId: template?.id ?? null,
      resolvedVersionNumber: resolved.resolvedVersionNumber ?? null,
      hasSchema: !!outputSchema,
      hyperparameters,
      selectedFragments: composed.selected,
    });

    return {
      userPrompt: composed.user,
      systemPrompt: composed.system,
      hyperparameters,
      responseFormat,
      resolvedFrom: resolved.resolvedFrom,
      promptId: resolved.promptId,
      // Truthful provenance: the version whose content was actually assembled
      // (agent pin / approvedVersionNumber), not the mutable template row.
      resolvedVersionNumber: resolved.resolvedVersionNumber ?? null,
      selected: [...composed.selected],
      excluded: composed.excluded.map(({ key, reason }) => ({ key, reason })),
      blocks: [...composed.blocks],
      ...(composed.governance ? { governance: composed.governance } : {}),
      platformPieces: platformPiecesOf({ platformRules: platformRules(), outputLanguageName: languageName, contractParts }),
    };
  }

  /**
   * TASK-1047 D1 — the STYLE REFERENCE block's content for a caller that composes the USER message
   * itself (the note plan): the doctor's DNA writing style and redaction rules, or `null` when
   * neither applies. A composed note plan carries no few-shot exemplars, as on the assembly.
   */
  async styleReference(params: Pick<PromptAssemblyParams, 'dnaStyleId' | 'dnaRedactionRulesText'>): Promise<string | null> {
    const style = params.dnaStyleId ? await this.resolveDnaStyleText(params.dnaStyleId) : null;
    return styleReferenceContent({ style, rules: params.dnaRedactionRulesText?.trim() || null });
  }

  /**
   * Compose through `composeMessages`, mapping its named failures.
   *
   * - An unresolved variable is the CALLER's 400 `PROMPT_VARIABLE_UNRESOLVED`, naming every path
   *   (and which of them the tenant's schema does not even declare). Nothing is rendered with a
   *   hole in it. Every name this assembly owns is always bound — empty when this encounter has
   *   no value — so only a name nothing populates can reach this.
   * - A body that does not PARSE is a governance defect reported at publish
   *   (`PROMPT_TEMPLATE_SYNTAX`); it must not cost the clinician this note, so the body is used
   *   verbatim, after the platform rules, and the defect is logged loudly.
   * - A composite whose every fragment was excluded is a 400 naming the keys.
   */
  private async compose(
    params: PromptAssemblyParams,
    promptId: string | null,
    input: {
      instruction: ComposableResolvedPrompt;
      rendered: Record<string, string>;
      agentVariables: Record<string, unknown>;
      variableDeclarations?: readonly PromptScopeVariableDeclaration[];
      outputContractParts: readonly OutputContractPart[];
      blockAliases: Readonly<Record<string, string>>;
      outputLanguage: { name: string } | null;
      dataBlocks: ComposeDataBlock[];
    },
  ): Promise<ComposedMessages> {
    const templateRef = promptId ?? params.promptType ?? 'prompt-assembly';
    const compose = (instruction: ComposableResolvedPrompt, outputContractParts: readonly OutputContractPart[]): ComposedMessages => {
      // `context` is the flat view every governed body reads (`{{context.safe_age}}`); `trigger`
      // is the run-payload envelope an agent's `{ path: 'trigger.context.*' }` binding reads; the
      // bare names are bound too, so a body authored either way renders the same bytes.
      const context = { ...input.rendered, ...noteContextAliases(input.rendered, params) };
      const scope = buildPromptScope({
        trigger: { context },
        context,
        variables: { ...input.rendered, ...input.agentVariables },
        variableDeclarations: input.variableDeclarations,
        templateRef,
      });
      return composeMessages({
        platformRules: platformRules(),
        resolvedPrompt: instruction,
        scope,
        outputLanguage: input.outputLanguage,
        // TASK-1047 FC-2 — static, keyed parts; each is one CONTRACT piece.
        ...(outputContractParts.length > 0 ? { outputContractParts } : {}),
        blockAliases: input.blockAliases,
        dataBlocks: input.dataBlocks,
        templateRef,
        // TASK-1036 OD-10 — a whitespace-only data section is dropped, not sent empty.
        dropEmptyBlocks: true,
      });
    };

    // A name this assembly OWNS that the body reads without a `default("…")` and this encounter
    // has no value for renders EMPTY — the always-defined convention of every value builder here
    // ("empty when none, never a literal placeholder"). A name nothing here owns is the caller's
    // 400. The loop terminates: each round binds at least one new owned name, or refuses.
    const bound = new Set(Object.keys(input.rendered));
    for (;;) {
      try {
        return compose(input.instruction, input.outputContractParts);
      } catch (error) {
        if (!(error instanceof PromptVariableUnresolvedError)) throw error;
        const owned = error.paths.map(bareName).filter((name) => OWNED_NAMES.has(name) && !bound.has(name));
        if (owned.length === 0) throw error;
        for (const name of owned) {
          bound.add(name);
          input.rendered[name] = '';
        }
      }
    }
  }

  /** `compose`, with the composer's named failures mapped to the caller's refusals. */
  private async composeOrRefuse(
    params: PromptAssemblyParams,
    promptId: string | null,
    input: Parameters<PromptAssemblyService['compose']>[2],
  ): Promise<ComposedMessages> {
    try {
      return await this.compose(params, promptId, input);
    } catch (error) {
      if (error instanceof PromptVariableUnresolvedError) {
        const missing = [...error.paths];
        const declared = new Set(await this.declaredContextNames(params));
        const undeclared = missing.filter((path) => !declared.has(bareName(path)));
        throw new BadRequestException({
          message: `The prompt references ${missing.length} variable(s) this assembly does not populate: ${missing.map((path) => `\`${path}\``).join(', ')}.`,
          code: 'PROMPT_VARIABLE_UNRESOLVED',
          path: error.path,
          missingVariables: missing,
          undeclaredByTheTenantSchema: undeclared,
          promptId,
        });
      }
      if (error instanceof PromptCompositionEmptyError) {
        throw new BadRequestException({
          message: 'No prompt fragment was selected: every fragment’s condition was false or could not be evaluated.',
          code: 'PROMPT_COMPOSITION_EMPTY',
          excluded: error.excluded.map((exclusion) => ({ key: exclusion.key, reason: exclusion.reason })),
          promptId,
        });
      }
      if (error instanceof PromptTemplateSyntaxError && input.instruction?.source !== 'composite') {
        this.logger.error({
          message: 'Governed prompt template does not parse; assembling it verbatim',
          promptId,
          promptType: params.promptType,
          error: error.message,
        });
        const verbatim = input.instruction?.content ?? '';
        return this.compose(params, promptId, {
          ...input,
          instruction: null,
          // The governed body, verbatim, as its own keyed part — static text, never a runtime value.
          outputContractParts: [...(verbatim.length > 0 ? [{ key: 'template-body-verbatim', text: verbatim }] : []), ...input.outputContractParts],
        });
      }
      throw error;
    }
  }

  /**
   * The names the TENANT's `consultation_legacy_v1` clone declares under its `context` kind.
   *
   * Read by slug under the caller's tenant — never SYSTEM's row. A context schema is CONTENT
   * (§1.5): SYSTEM holds the reference set the tenant is CLONED from, and reading it at runtime
   * would serve the platform's copy to a tenant that has its own.
   *
   * TASK-890 L13 — a tenant with NO clone is a named, fail-closed `LEGACY_CONTEXT_SCHEMA_MISSING`:
   * the reference set is provisioned at tenant creation and backfilled for every existing tenant,
   * so a missing clone is a real provisioning gap and the remedy — a re-sync — is named in the
   * error. A lookup that FAILS (a database blip) still degrades to `[]` — an infrastructure error
   * must not be reported to a clinician as a governance defect, and the classification this list
   * feeds is diagnostic.
   *
   * It is reached only when an instruction references a variable nothing populated, which is
   * precisely when the declared set decides how the refusal reads (declared but unsupplied, or
   * not declared at all). Every other generation is untouched.
   */
  private async declaredContextNames(params: PromptAssemblyParams): Promise<string[]> {
    const tenantId = params.tenantId ?? this.cls?.get('tenantId');
    if (!tenantId || !this.contextSchemaRepository || !this.contextSchemaVersionRepository) return [];

    let schema: Awaited<ReturnType<NonNullable<typeof this.contextSchemaRepository>['findByTenantAndSlug']>> | null = null;
    try {
      schema = await this.contextSchemaRepository.findByTenantAndSlug(tenantId, LEGACY_CONTEXT_SCHEMA_SLUG);
    } catch (error) {
      // A governance lookup must never fail a generation on an infrastructure error.
      this.logger.warn({
        message: 'Legacy context-schema lookup failed; refusing without the declared-name classification',
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }

    if (!schema || schema.pinnedVersionNumber == null) {
      this.logger.error({
        message: 'LEGACY_CONTEXT_SCHEMA_MISSING — this tenant has no pinned clone of the legacy context schema',
        tenantId,
        slug: LEGACY_CONTEXT_SCHEMA_SLUG,
      });
      throw new ServiceUnavailableException({
        code: 'LEGACY_CONTEXT_SCHEMA_MISSING',
        message:
          'This tenant has not been provisioned with the platform legacy context schema, so the variables this prompt references cannot be validated. Re-sync its reference set (POST /admin/tenants/{id}/reference-set/sync).',
        slug: LEGACY_CONTEXT_SCHEMA_SLUG,
        tenantId,
      });
    }

    try {
      const version = await this.contextSchemaVersionRepository.findBySchemaAndVersionNumber(schema.id, schema.pinnedVersionNumber);
      if (!version) return [];
      const payloadSchema = payloadSchemaFromDefinition(version.definition);
      const properties = (payloadSchema.properties as Record<string, unknown> | undefined)?.context;
      const fields =
        properties !== null && typeof properties === 'object' ? (properties as { properties?: Record<string, unknown> }).properties : undefined;
      return fields ? Object.keys(fields) : [];
    } catch (error) {
      this.logger.warn({
        message: 'Legacy context-schema version lookup failed; refusing without the declared-name classification',
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * The values of the names this assembly OWNS (`OWNED_NAMES`). The always-present ones are bound
   * even when empty; the optional ones only when this encounter has a value.
   */
  private async buildVariables(params: PromptAssemblyParams, referenced: ReadonlySet<string>): Promise<Record<string, string>> {
    const variables: Record<string, string> = {
      conversation_language: params.conversationLanguage,
      transcript: params.transcript,
      ner_entities: serializeNerEntities(params.nerEntities ?? []),
      clinician_notes: serializeTextBlock(params.clinicianNotes),
      attachments: serializeTextBlock(params.attachments),
      case_notes: serializeTextBlock(params.caseNotes),
      recent_vitals: params.vitals?.trim() ?? '',
      previous_case_notes_summary: params.previousVisits?.trim() ?? '',
      // TASK-1020 — `formatted_test_results` is v1's own name, so the pre-summary builder below
      // writes the same value when a v1 body is resolved.
      formatted_test_results: params.testResults?.trim() ?? '',
      same_day_prequel_summary: params.sameDayPrequelSummary?.trim() ?? '',
      doctor_highlights: serializeTextBlock(params.highlights),
    };

    // OPTIONAL names are bound only when this encounter has a value, so a body's own
    // `default("…")` still speaks for an absent one (an absent name the body reads WITHOUT a
    // default is bound empty at compose time — see `compose`).
    //
    // The prior draft reaches the model only where the governed body asks for it by name — the
    // author's explicit placement.
    if (params.preSummaryText && referenced.has('pre_summary_text')) variables.pre_summary_text = params.preSummaryText;
    // Carried prior-visit summary (F-18), whole: the note budget decides what fits, never a cut.
    if (params.priorVisitSummary?.trim()) variables.prior_visit_summary = params.priorVisitSummary.trim();
    if (params.dnaRedactionRulesText?.trim()) variables.dna_redaction_rules_text = params.dnaRedactionRulesText.trim();

    // v1's nine pre-summary placeholders. The seeded pre-summary bodies — the ArcaAI tenant row
    // AND the SYSTEM default `71000000-…040` — carry `{{context.current_department}}`,
    // `{{context.visit_type}}`, `{{context.safe_age}}`, … Gated on the instruction actually
    // referencing them, so a summary template never pays for the department lookup.
    if (referencesPreSummaryVariables(referenced)) {
      Object.assign(
        variables,
        buildPreSummaryVariables({
          currentDepartment: await this.resolveDepartmentName(params.departmentId),
          visitType: params.visitType,
          // Vitals and prior visits are what the CLIENT stated at `open`, validated against the
          // tenant's own context schema and read back through the shared reader. Passed THROUGH
          // the builder rather than assigned after it, so both inherit v1's `|| default`
          // semantics instead of a second copy of them. Demographics have no source in the v2
          // data model, so those fall through to v1's own default — Unknown.
          vitals: params.vitals,
          previousVisits: params.previousVisits,
          testResults: params.testResults,
          language: params.conversationLanguage,
        }),
      );
      // TASK-1001 — every caller passes the NOTE OUTPUT language (the platform default), and v1's
      // map knows only en/ml, so a Hindi default rendered "English". Name it natively. A
      // code-switch tag (`ml-en`) fails the output grammar and keeps v1's defused "English".
      const nativeName = summaryLanguageName(parseLanguageTag(params.conversationLanguage));
      if (nativeName) variables.language_name = nativeName;
    }

    // The DNA writing style is DOCTOR-level: one style per doctor, substituted into whichever
    // `style_DNA_*` slot the instruction uses and exposed as `dna_style_text` for the guidance the
    // system message carries when the body names no slot.
    const styleText = params.dnaStyleId ? await this.resolveDnaStyleText(params.dnaStyleId) : null;
    if (styleText) {
      variables.dna_style_text = styleText;
      for (const key of this.getDnaVariableKeys()) {
        if (referenced.has(key)) variables[key] = styleText;
      }
    }

    return variables;
  }

  /**
   * The department NAME for v1's `{current_department}` placeholder.
   *
   * Never throws: `{current_department}` is prompt context, not a precondition,
   * so a missing id, a missing row, or a repository failure all degrade to v1's
   * own `'General'` default rather than failing the generation.
   */
  private async resolveDepartmentName(departmentId?: string): Promise<string | null> {
    if (!departmentId || !this.departmentRepository) return null;
    try {
      const department = await this.departmentRepository.findById(departmentId);
      return department?.name ?? null;
    } catch (error) {
      this.logger.warn(
        `Department lookup failed for ${departmentId}; pre-summary {current_department} falls back to the v1 default: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Fetch the DECRYPTED DNA writing-style text for a report id.
   *
   * The `styleText` column is Vault-Transit ciphertext — the plaintext column was
   * dropped in Phase 6 — so the generic `findById` (which never decrypts) returns
   * an entity whose `styleText` is always undefined in a Vault-backed environment.
   * With a `SecretsService` wired we MUST go through the decrypting repository
   * method; without one we fall back to the legacy non-decrypting read (a latent
   * no-op in prod, but what the previous code did and what secrets-less test
   * fixtures rely on). Never throws — DNA style is additive; on any failure we
   * proceed without it.
   */
  private async resolveDnaStyleText(dnaStyleId: string): Promise<string | null> {
    try {
      if (this.secretsService) {
        const { plaintext } = await this.dnaWritingStyleRepository.findByIdWithDecryptedFields(dnaStyleId, this.secretsService);
        return plaintext.styleText?.trim() || null;
      }
      const entity = (await this.dnaWritingStyleRepository.findById(dnaStyleId)) as { styleText?: string | null } | null;
      return entity?.styleText?.trim() || null;
    } catch (error) {
      this.logger.warn(
        `DNA writing-style resolution failed for ${dnaStyleId}; proceeding without style: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private getDnaVariableKeys(): readonly string[] {
    return DNA_STYLE_VARIABLE_KEYS;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractPromptConfig(template: any): {
    hyperparameters?: Record<string, number>;
    outputSchema?: Record<string, unknown>;
  } | null {
    if (!template?.metaData) return null;

    const metaData = template.metaData as Record<string, unknown>;
    const promptConfig = metaData.promptConfig as Record<string, unknown> | undefined;
    if (!promptConfig) return null;

    return {
      hyperparameters: (promptConfig.hyperparameters as Record<string, number>) ?? undefined,
      outputSchema: (promptConfig.outputSchema as Record<string, unknown>) ?? undefined,
    };
  }
}
