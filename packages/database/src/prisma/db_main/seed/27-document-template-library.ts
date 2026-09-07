/**
 * TASK-891 (Lane D / W6) — the PLATFORM DOCUMENT-TEMPLATE REFERENCE LIBRARY.
 *
 * Two SYSTEM-tenant `DocumentTemplate` rows (+ their pinned v1
 * `DocumentTemplateVersion` snapshots) that declare the SHAPE of the live
 * running case note for the platform's two visit types.
 *
 * This phase seeds the SOURCE CONTENT only. Copying it into a tenant is
 * PROVISIONING, and provisioning has exactly one seed-side owner:
 * `26-tenant-reference-set.ts`, whose `copyDocumentTemplates` is the mirror of
 * `TenantReferenceSetService.copyDocumentTemplates`. This file used to carry a
 * second per-tenant clone loop of its own, which meant the reference set was
 * provisioned from two places that nothing compared — the divergence
 * `tenant-reference-set-parity.contract.test.ts` exists to catch.
 *
 * ## Why two shapes and not one
 *
 * The owner's requirement is "a pre-defined template set in each workflow,
 * depends on selected department (as-tag) and visit-type (as-tag)". A template
 * SET needs at least two members that genuinely differ, or the axis is
 * decorative. These two do: 21 section slots across the pair resolve to 18
 * DISTINCT keys — only three are shared (`examination_and_vitals`,
 * `previous_diagnosis`, `current_diagnosis`).
 * A new/referral note collects the history that a follow-up already has on
 * file; a follow-up note instead tracks change — last visit's complaints and
 * their status today, this result against the one immediately before it, and
 * the operative order set for the encounter.
 *
 * ## Where the shapes come from — the PromptTemplate reuse (Task A)
 *
 * They are the HEADING LISTS of the ArcaAI clinical prompt corpus
 * (`07b-arcaai-clinical-content-v3.ts`), the department x visit-type templates
 * the customer already signed off. Those bodies are ~15 KB each and split three
 * ways: a ~10 KB safety protocol (byte-identical across all 22 bodies), a ~4-6 KB
 * HEADING BLOCK, and a ~0.9 KB emit checklist. Only the heading block is a
 * document SHAPE; the rest is instruction, and instruction is what a
 * `PromptTemplate` is for.
 *
 * So the split is: the prompt keeps the protocol and keeps governing the
 * FINALIZE note (per department x visit type, through
 * `Department.newPatientPromptId` / `revisitPromptId`, which is live, not
 * deprecated); this library governs the REALTIME running note, which
 * `resolveForGeneration` is the only consumer of. What they must AGREE on is
 * the heading list — the corpus header calls the headings "the EMR's section
 * keys, not prose" — and today they do not: the live note is four SOAP
 * sections while the finalized note is ten or eleven department headings, so a
 * clinician watches one document being written and signs a different one.
 * These two rows are what closes that.
 *
 * Three things stopped the prompt bodies being lifted MECHANICALLY, all
 * measured rather than assumed:
 *
 *  1. SIZE. The protocol block of `MEDICINE_NEW_REFERRAL_CONTENT_V3` is 10,119
 *     characters; `shape.globalInstruction` caps at 10,000
 *     (`document-template-shape.ts`). It does not fit, by 119 characters.
 *  2. SEMANTICS. The corpus's RULE 3 says "Omitting a heading is always correct
 *     ... Never write 'not mentioned', 'not discussed', ... 'N/A'". The compiler
 *     emits a STRICT `json_schema` in which every key is required and absence is
 *     the `null` sentinel ("Every key must be present."). Lifted verbatim, RULE 3
 *     tells the model to do the one thing the decoder forbids. It is restated
 *     below, marked as an adaptation.
 *  3. STRUCTURE. `sections[]` is FLAT. The new/referral body nests five
 *     sub-items under "Plan of Care", and RULES 1/2/4 refer to input tiers
 *     T1-T4 and to per-heading "SOURCE:" lines that only exist inside the
 *     source document's own frame.
 *
 * What IS carried verbatim: RULE 7's opening (NEVER INVENT) and RULE 9 (NO AI
 * AUTHORSHIP), both transport-neutral. What is deliberately NOT carried: RULES
 * 2, 4, 5, 6 and 8 and the INPUT TIERS block, because they govern the prior
 * record, the pre-summary and `Recent Vitals` — inputs the realtime flush does
 * not receive (they arrive on the finalize path, behind
 * `consultation.assemblePrompt` with `requiresFinalized: true`). Spending a
 * frozen prefix on rules about absent inputs buys nothing.
 *
 * ## What is deliberately NOT seeded
 *
 * `soap_note`. It is `SOAP_NOTE_SLUG`, the code-level fail-open default in
 * `platform-document-shapes.ts` that `resolveForGeneration` already returns when
 * a tenant has no row. A byte-identical row would shadow the default with a copy
 * of itself and buy nothing; a DIFFERENT row under that slug would silently
 * change what every existing workflow resolves, since
 * `24-example-consultation-workflows.ts` names `documentTemplateSlug:
 * 'soap_note'` on its realtime node. Neither is wanted, so the slug is left
 * alone and these two get their own.
 *
 * ## Status, default, and why nothing changes until a workflow asks
 *
 *  - `PUBLISHED`, not `APPROVED`. `isServable` accepts both; `APPROVED` means a
 *    clinician signed the shape off, and seeding that would fabricate a
 *    governance act (the same objection `seed-mode.ts` records against seeding
 *    `23-arcaai-workflow-authoring` outside dev).
 *  - `isDefault: false` on both. `resolveForGeneration(tenantId)` with no slug
 *    reads the tenant DEFAULT; making one of these it would apply a new/referral
 *    shape to a follow-up whenever a workflow named nothing. The selector is the
 *    workflow's `documentTemplateSlug` (OD-2), so an unnamed lane keeps falling
 *    open to the platform SOAP shape exactly as it does today.
 *
 * Consequence, stated plainly: seeding these rows changes NO runtime behaviour
 * on its own. A workflow's `consultation.realtimeSummary` node has to name one
 * of the two slugs, and the visit-type-qualified `WorkflowAssignment` (Lane D,
 * D1-D5) has to pick the matching workflow. Both live outside this file.
 *
 * ## Content is cloned; configuration cascades
 *
 * `DocumentTemplate` is CONTENT (`00-project-context.md`), it is not in
 * `SYSTEM_SHARED_READ_MODELS`, and `resolveForGeneration` reads the REQUEST
 * tenant only. A SYSTEM row is therefore invisible to a tenant at runtime — it
 * is a reference row to be COPIED, never resolved across the boundary.
 *
 * All three copiers now do that copy, from the same set in the same order: the
 * runtime `TenantReferenceSetService` (so a tenant created through
 * `POST /admin/tenants` is born with the pair), the `reference-set/sync` route
 * (so an existing tenant can be repaired), and seed phase 26 (so the directly
 * written seed tenants, Global and ArcaAI, are provisioned too). Each is
 * create-only on `(tenantId, slug)`, so a tenant admin's own edit survives.
 *
 * Because phase 26 reads these rows OUT OF THE DATABASE, this phase runs
 * BEFORE it in `index.ts` — the SYSTEM library has to exist before a tenant can
 * be provisioned from it.
 *
 * ## The compiler port
 *
 * `packages/database` may not import `@arcaai/applications` (that closes the
 * cycle applications -> domains -> database), so `compileShape` below is a
 * second implementation of `compileDocumentTemplate`, exactly as `07e` carries a
 * second copy of the canonicalisers. It is not trusted on inspection:
 * `platform-reference-shapes.task891.test.ts` in `@arcaai/applications` imports
 * this module by relative path and asserts the artifacts frozen here are
 * DEEP-EQUAL to what the real compiler emits for the same shapes — the same
 * cross-package parity guard `day1-loop-defaults.task686.test.ts` applies to the
 * checksums.
 *
 * ID blocks (registered nowhere else; see the report — `00-constants.ts` is
 * outside this lane's boundary):
 *   8a000000-…-XXXX-… DocumentTemplate            (slot 0000 = SYSTEM reference)
 *   8b000000-…-XXXX-… DocumentTemplateVersion     (mirror slot)
 * Lower-case hex deliberately: PostgreSQL `uuid` is case-insensitive, and the
 * E0/F0 collision recorded in `00-constants.ts` came from mixing cases.
 */
import { createHash } from 'node:crypto';

import type { CorePrismaClient } from '../../../client';
import type { DocumentTemplateStatus } from '../../../generated/core-prisma-client/enums';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import { canonicalJson } from './07e-consultation-loop-defaults';

// =============================================================================
// Shape types — structural mirrors of `document-template-shape.ts`
// =============================================================================

type DocumentSectionForm = 'PROSE' | 'BULLETS' | 'STRUCTURED';

interface SeedSectionDeclaration {
  key: string;
  title: string;
  form: DocumentSectionForm;
  instruction?: string;
  required?: boolean;
  description?: string;
  maxChars?: number;
}

interface SeedDocumentShape {
  schemaVersion: '1.0';
  title: string;
  globalInstruction?: string;
  sections: SeedSectionDeclaration[];
}

// =============================================================================
// The shared protocol excerpt
// =============================================================================

/**
 * `globalInstruction` for both shapes.
 *
 * Provenance, line by line — the ATTRIBUTION and NO AI AUTHORSHIP paragraphs and
 * the first two sentences of NEVER INVENT are VERBATIM from Block A of the
 * ArcaAI v3 corpus (byte-identical across all 22 department bodies; asserted by
 * this lane's seed test). EMPTY IS CORRECT is the one ADAPTATION: the corpus
 * sentence "Omitting a heading is always correct" cannot survive a strict
 * `json_schema` in which every key is required, so its intent is restated
 * against the `null` sentinel the compiler actually emits.
 *
 * The closing paragraph is new and belongs to the realtime lane specifically: a
 * running note is regenerated on every flush, and the compiler's state machine
 * permits `DRAFTED -> NOT_DISCUSSED` for exactly this reason.
 *
 * "ICD-10" appears nowhere, deliberately — the containment bar of
 * `icd10-prompt-containment.test.ts` is a blanket substring ban, including in a
 * negated sentence, and the corpus's own fix wording ("a diagnostic code") is
 * used instead.
 */
export const REALTIME_NOTE_PROTOCOL = [
  'Maintain a concise, factual running clinical note from the live consultation transcript.',
  '',
  "ATTRIBUTION. Write a statement only if a reader could point to the part of today's transcript that supports it.",
  '',
  'EMPTY IS CORRECT. A short accurate note is a correct note. A complete-looking note containing one unsupported ' +
    'statement is a documentation failure and a legal defect. Never write "not mentioned", "not discussed", ' +
    '"not applicable", "none", "nil", "N/A", "-" or any other placeholder — set the section to null instead.',
  '',
  'NEVER INVENT. Do not create, complete or infer: patient identifiers, hospital or visit numbers, dates, ' +
    'diagnostic codes, drug names, doses, routes, frequencies, durations, laboratory or imaging values, scores, ' +
    'stages, grades, counts, clinician names or signatures. Never record a diagnostic code — state the diagnosis ' +
    'in words only; codes are attached separately from a verified terminology source.',
  '',
  'NO AI AUTHORSHIP. Record only what the clinician said. Add no advice, no interpretation, no differential, no ' +
    'reassurance, no risk statement and no recommendation of your own — not even a clinically obvious or a ' +
    'safety-motivated one. If the clinician did not say it, it does not appear.',
  '',
  'The consultation is still in progress. A section that is null now may fill later, and a section the later ' +
    'transcript no longer supports must go back to null.',
].join('\n');

// =============================================================================
// Shape 1 — new / referral visit
// =============================================================================

export const NEW_VISIT_NOTE_SLUG = 'consultation_note_new_visit';

/**
 * The ten headings of the corpus's New/Referral body, in source order.
 *
 * "Plan of Care" stays ONE section with its sub-items named in the instruction,
 * rather than being flattened into siblings: the source declares one heading
 * with five sub-items, and splitting it would be an authoring decision rather
 * than a reuse. The department-specific sub-item ("Diabetes-Specific") is
 * dropped — this is the platform reference shape, and a tenant that wants it
 * adds it to its own clone.
 *
 * Not one section is `required`. See the D-21 docblock on
 * `platform-document-shapes.ts`: under `strict: true` a required section forbids
 * the decoder from representing "not discussed", so it invents. Ten sections
 * would be ten invitations.
 */
export const NEW_VISIT_NOTE_SHAPE: SeedDocumentShape = {
  schemaVersion: '1.0',
  title: 'Consultation Note — New / Referral Visit',
  globalInstruction: REALTIME_NOTE_PROTOCOL,
  sections: [
    {
      key: 'presenting_complaints',
      title: 'Presenting Complaints',
      form: 'BULLETS',
      instruction:
        "Today's transcript only. Each chief complaint with its onset, duration, severity and associated features. " +
        'Record an attribute only where it was stated — never grade a severity yourself, and never supply an onset ' +
        'or duration from the prior record.',
    },
    {
      key: 'past_history',
      title: 'Past History',
      form: 'PROSE',
      instruction:
        'Relevant medical, surgical and hospital-admission history as the patient reported it today. A prior-record ' +
        'entry may appear only if it was raised today, and it then carries its date.',
    },
    {
      key: 'family_history',
      title: 'Family History',
      form: 'BULLETS',
      instruction: "Today's transcript only. Familial illnesses with the degree of relation. Record a relation only where it " + 'was specified.',
    },
    {
      key: 'drug_history',
      title: 'Drug History',
      form: 'BULLETS',
      instruction:
        'Current and past medications with dose, duration and adherence. Reproduce names and doses as spoken; ' +
        'adherence appears only as the patient described it. A previously documented drug may appear only if it ' +
        'was raised today, and it then carries its date.',
    },
    {
      key: 'hospital_admissions',
      title: 'Hospital Admissions',
      form: 'BULLETS',
      instruction: 'Prior inpatient stays with their dates, diagnoses and procedures. Dates appear only when stated — do not ' + 'approximate.',
    },
    {
      key: 'examination_and_vitals',
      title: 'General Examination & Vitals',
      form: 'PROSE',
      instruction:
        'Examination findings and vital signs measured or spoken today — heart rate, blood pressure, respiratory ' +
        'rate, temperature, weight and systemic findings. Do not complete a partial set. State a trend only where ' +
        'two or more dated values support it, and show both values with their dates.',
    },
    {
      key: 'previous_diagnosis',
      title: 'Previous Diagnosis',
      form: 'BULLETS',
      instruction:
        'Chronic or pre-existing diagnoses carried forward. Prior-record content is permitted here — date every ' +
        'entry. Do not infer a diagnosis from a medication.',
    },
    {
      key: 'reports',
      title: 'Reports',
      form: 'BULLETS',
      instruction:
        'Investigations discussed today — imaging and laboratory results — with their values and dates reproduced ' +
        'exactly. Do not list an investigation that was not discussed, and do not interpret a result the clinician ' +
        'did not interpret.',
    },
    {
      key: 'current_diagnosis',
      title: 'Current Diagnosis',
      form: 'PROSE',
      instruction:
        "Today's transcript only. The working or confirmed diagnosis, by name. Do not write, guess or transcribe a " +
        'diagnostic code — codes are attached separately from a verified terminology source. If no diagnosis was ' +
        'given today, leave this section null rather than repeating the previous one.',
    },
    {
      key: 'plan_of_care',
      title: 'Plan of Care',
      form: 'PROSE',
      instruction:
        "Today's transcript only — what was decided in THIS encounter: treatment orders (name, dose, route, " +
        'duration), investigations ordered with the rationale the clinician gave, the follow-up interval and any ' +
        'referrals, and preventive care actually discussed. Record only components that were spoken. If nothing was ' +
        'decided today, leave this section null; never restate the previous plan here.',
    },
  ],
};

// =============================================================================
// Shape 2 — follow-up / review visit
// =============================================================================

export const REVISIT_NOTE_SLUG = 'consultation_note_revisit';

/**
 * The eleven numbered headings of the corpus's Review (follow-up) body, in
 * source order. The numbering itself is dropped — array order IS the order
 * (`compiled.sectionKeys` preserves it), so carrying "1." in a title would be a
 * second, drift-prone statement of the same fact.
 *
 * This is the shape that makes the visit-type axis real. Against the new/referral
 * shape it drops six sections outright (presenting complaints, past/family/drug
 * history, hospital admissions, reports) and adds eight that only make sense on
 * a return visit.
 */
export const REVISIT_NOTE_SHAPE: SeedDocumentShape = {
  schemaVersion: '1.0',
  title: 'Consultation Note — Follow-up / Review Visit',
  globalInstruction: REALTIME_NOTE_PROTOCOL,
  sections: [
    {
      key: 'new_complaints',
      title: 'New Complaints',
      form: 'BULLETS',
      instruction:
        "Today's transcript only. Symptoms reported for the first time at this visit, with onset, duration, " +
        'severity, progression and associated symptoms. A symptom is new only if the patient raised it today and it ' +
        'is not documented in the prior record.',
    },
    {
      key: 'last_visit_complaints',
      title: 'Last Visit Complaints',
      form: 'BULLETS',
      instruction:
        'The complaints documented at the previous visit, dated, each with the status the patient gave TODAY — ' +
        'resolved, improving, persisting or worsening. If a previously documented symptom was not discussed today, ' +
        'list it with its date and no status: never infer that it resolved, and never infer that it persists.',
    },
    {
      key: 'previous_diagnosis',
      title: 'Previous Diagnosis',
      form: 'BULLETS',
      instruction:
        'Established chronic conditions and working diagnoses carried over from past encounters. Prior-record ' +
        'content is permitted here — date every entry. Do not infer a diagnosis from a medication or from a symptom.',
    },
    {
      key: 'current_medications',
      title: 'Current Medications',
      form: 'BULLETS',
      instruction:
        'Drugs the patient is actively taking at this visit, with name, dose, frequency and adherence. "Currently ' +
        'taking" means the patient or clinician said so today — do not populate this list from the previous ' +
        'prescription on the assumption that it continues. Exclude discontinued medications.',
    },
    {
      key: 'investigations',
      title: 'Investigations (Previous vs Current)',
      form: 'BULLETS',
      instruction:
        'The latest result against the one immediately before it, both dated, with a concise trend — improving, ' +
        'stable or worsening. Compare only tests for which two dated values are actually available; where only one ' +
        'exists, report it with its date and no trend. Never estimate, interpolate or round a value to make a ' +
        'comparison work.',
    },
    {
      key: 'examination_and_vitals',
      title: 'General Examination & Vitals',
      form: 'PROSE',
      instruction:
        'Examination findings and vital signs measured at this visit — heart rate, blood pressure, temperature, ' +
        'respiratory rate, oxygen saturation. A historical value may be reported for comparison only where the ' +
        'clinician referred to it today, and its date must appear beside it. Do not complete a partial set from the ' +
        'record.',
    },
    {
      key: 'current_diagnosis',
      title: 'Current Diagnosis',
      form: 'PROSE',
      instruction:
        "Today's transcript only. The definitive or updated working diagnosis reached at this visit, by name. Do " +
        'not write, guess or transcribe a diagnostic code — codes are attached separately from a verified ' +
        'terminology source. A carried-forward diagnosis belongs under Previous Diagnosis, dated.',
    },
    {
      key: 'treatment_plan',
      title: 'Treatment Plan',
      form: 'PROSE',
      instruction:
        "Today's transcript only. Modifications to existing therapy, newly initiated therapy and planned " +
        'procedures. "Continued unchanged" is recorded only if the clinician said so. If no plan was formulated ' +
        'today, leave this section null; never restate the previous plan here.',
    },
    {
      key: 'follow_up_plan',
      title: 'Follow-up Plan',
      form: 'PROSE',
      instruction:
        "Today's transcript only. The interval or date of the next visit, the clinical goals to be reached by then, " +
        'and any cross-departmental referrals.',
    },
    {
      key: 'additional_data',
      title: 'Additional Data',
      form: 'BULLETS',
      instruction:
        'Preventive screenings and vaccinations discussed, reviewed or administered at this visit. Include an item ' +
        'only if it was raised today; a date taken from the prior record carries "(record, <date>)".',
    },
    {
      key: 'instructions_and_orders',
      title: "Doctor's Instructions & Orders",
      form: 'BULLETS',
      instruction:
        "Today's transcript only — the operative order set for this encounter: active medication orders (name, " +
        'dose, route, duration), newly ordered investigations, and active lifestyle or dietary restrictions. State ' +
        'explicitly any medication the clinician stopped. A drug’s absence from today’s conversation is not a ' +
        'discontinuation and must not be reported as one.',
    },
  ],
};

// =============================================================================
// The compiler port — see the file header for why this is a second implementation
// =============================================================================

/** Copy of `DOCUMENT_TEMPLATE_COMPILER_VERSION`. */
export const SEED_DOCUMENT_TEMPLATE_COMPILER_VERSION = '1.0.0';

/** Copy of `DOCUMENT_SECTION_STATES`. */
const SECTION_STATES = ['PENDING', 'NOT_DISCUSSED', 'DRAFTED', 'CONFIRMED'] as const;

/** Copy of the compiler's shape-independent `TRANSITIONS` table. */
const SECTION_TRANSITIONS = [
  { from: 'PENDING', to: 'DRAFTED', on: 'CONTENT_EMITTED' },
  { from: 'PENDING', to: 'NOT_DISCUSSED', on: 'EMITTED_NULL' },
  { from: 'NOT_DISCUSSED', to: 'DRAFTED', on: 'CONTENT_EMITTED' },
  { from: 'DRAFTED', to: 'DRAFTED', on: 'CONTENT_EMITTED' },
  { from: 'DRAFTED', to: 'NOT_DISCUSSED', on: 'EMITTED_NULL' },
  { from: 'DRAFTED', to: 'CONFIRMED', on: 'CLINICIAN_CONFIRMED' },
  { from: 'NOT_DISCUSSED', to: 'CONFIRMED', on: 'CLINICIAN_CONFIRMED' },
] as const;

/** Copy of the compiler's `sectionProperty` for the PROSE / BULLETS subset. */
function sectionProperty(section: SeedSectionDeclaration): Record<string, unknown> {
  if (section.form === 'STRUCTURED') {
    // The library declares no STRUCTURED section, and porting `strictify` +
    // `authorableJsonSchemaProblems` for a case that does not arise would be a
    // second implementation of a second implementation. The seed test asserts
    // the precondition rather than trusting it.
    throw new Error(`section \`${section.key}\`: the seed compiler port does not support STRUCTURED sections`);
  }

  const description = [section.instruction, section.description].filter((part): part is string => Boolean(part && part.trim())).join(' ');

  let property: Record<string, unknown> = { type: 'string' };
  if (section.maxChars !== undefined) property.maxLength = section.maxChars;
  if (description) property = { ...property, description };

  if (section.required === true) return property;
  // The D-21 sentinel: an optional section is NULLABLE, never a missing key.
  return { ...property, type: ['string', 'null'] };
}

/** Copy of the compiler's `promptInstruction`. */
function promptInstruction(shape: SeedDocumentShape): string {
  const lines = shape.sections.map((section) => {
    const form = section.form === 'BULLETS' ? 'bullet points' : section.form === 'STRUCTURED' ? 'a JSON object' : 'prose';
    const purpose = section.instruction?.trim() ? ` ${section.instruction.trim()}` : '';
    const optionality = section.required === true ? ' [required]' : '';
    return `  "${section.key}" — ${section.title} (${form})${optionality}:${purpose}`;
  });

  const optional = shape.sections.filter((section) => section.required !== true).map((section) => `"${section.key}"`);

  const parts = [
    `Output a single JSON object with EXACTLY these keys, in this order, and nothing else:`,
    '',
    ...lines,
    '',
    'Every key must be present.',
  ];

  if (optional.length > 0) {
    parts.push(
      `If a section was not discussed, set its value to null — do NOT write "none", "N/A", "not discussed", ` +
        `or invent content to fill the heading. Nullable sections: ${optional.join(', ')}.`,
    );
  }

  parts.push('Do not add sections that are not listed above.');

  if (shape.globalInstruction?.trim()) {
    parts.push('', shape.globalInstruction.trim());
  }

  return parts.join('\n');
}

/**
 * Copy of `compileDocumentTemplate`, restricted to the PROSE / BULLETS subset.
 * Parity with the real compiler is asserted from `@arcaai/applications` — see
 * the file header.
 */
export function compileShape(shape: SeedDocumentShape): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const checklist: Record<string, unknown>[] = [];
  const sections: Record<string, { allowNotDiscussed: boolean }> = {};

  for (const section of shape.sections) {
    properties[section.key] = sectionProperty(section);
    checklist.push({
      key: section.key,
      title: section.title,
      form: section.form,
      required: section.required === true,
      ...(section.instruction ? { instruction: section.instruction } : {}),
    });
    sections[section.key] = { allowNotDiscussed: section.required !== true };
  }

  const sectionKeys = shape.sections.map((section) => section.key);

  return {
    compilerVersion: SEED_DOCUMENT_TEMPLATE_COMPILER_VERSION,
    title: shape.title,
    sectionKeys,
    responseFormat: {
      type: 'json_schema',
      strict: true,
      json_schema: {
        title: shape.title,
        type: 'object',
        additionalProperties: false,
        properties,
        required: sectionKeys,
      },
    },
    checklist,
    sectionStates: {
      states: SECTION_STATES,
      initial: 'PENDING',
      terminal: ['CONFIRMED'],
      transitions: SECTION_TRANSITIONS,
      sections,
    },
    promptInstruction: promptInstruction(shape),
  };
}

/** Copy of `computeShapeChecksum` (= `computeDefinitionChecksum`), via `07e`'s canonicaliser. */
export const shapeChecksum = (shape: unknown): string => createHash('sha256').update(canonicalJson(shape)).digest('hex');

// =============================================================================
// The seeded rows
// =============================================================================

export interface DocumentTemplateLibraryEntry {
  id: string;
  versionId: string;
  slug: string;
  name: string;
  description: string;
  shape: SeedDocumentShape;
  compiled: Record<string, unknown>;
  checksum: string;
}

const entry = (
  id: string,
  versionId: string,
  slug: string,
  name: string,
  description: string,
  shape: SeedDocumentShape,
): DocumentTemplateLibraryEntry => ({
  id,
  versionId,
  slug,
  name,
  description,
  shape,
  compiled: compileShape(shape),
  checksum: shapeChecksum(shape),
});

export const DOCUMENT_TEMPLATE_LIBRARY: readonly DocumentTemplateLibraryEntry[] = [
  entry(
    '8a000000-0000-0000-0000-000000000001',
    '8b000000-0000-0000-0000-000000000001',
    NEW_VISIT_NOTE_SLUG,
    'Consultation Note — New / Referral Visit',
    'Platform reference SHAPE for the live running note of a new or referred patient. Section list ported from the ' +
      'signed-off department x visit-type prompt corpus so the running note and the finalized note share one set of ' +
      'EMR section keys.',
    NEW_VISIT_NOTE_SHAPE,
  ),
  entry(
    '8a000000-0000-0000-0000-000000000002',
    '8b000000-0000-0000-0000-000000000002',
    REVISIT_NOTE_SLUG,
    'Consultation Note — Follow-up / Review Visit',
    'Platform reference SHAPE for the live running note of a follow-up visit. Tracks change rather than collecting ' +
      'history: last visit’s complaints and their status today, this result against the one immediately before it, ' +
      'and the operative order set for the encounter.',
    REVISIT_NOTE_SHAPE,
  ),
] as const;

// =============================================================================
// Seeding
// =============================================================================

/** Upsert-by-id the SYSTEM reference rows. */
async function seedSystemLibrary(client: CorePrismaClient): Promise<void> {
  for (const item of DOCUMENT_TEMPLATE_LIBRARY) {
    const head = {
      id: item.id,
      tenantId: SYSTEM_TENANT_ID,
      slug: item.slug,
      name: item.name,
      description: item.description,
      status: 'PUBLISHED' as DocumentTemplateStatus,
      pinnedVersionNumber: 1,
      isDefault: false,
      sourceTemplateSlug: null,
      templateLocked: false,
      createdBy: SYSTEM_USER_ID,
    };
    await client.documentTemplate.upsert({ where: { id: item.id }, update: head, create: head });

    // The version row is IMMUTABLE by design, so the update payload restates the
    // same derived bytes rather than carrying operator-owned state. Refreshing
    // it is what lets a corrected shape reach a dev database that already ran
    // the phase; a real environment reaches a new shape through `publish`.
    const version = {
      id: item.versionId,
      tenantId: SYSTEM_TENANT_ID,
      templateId: item.id,
      versionNumber: 1,
      shape: item.shape as never,
      compiled: item.compiled as never,
      compilerVersion: SEED_DOCUMENT_TEMPLATE_COMPILER_VERSION,
      checksum: item.checksum,
      changeReason: 'Platform reference shape (TASK-891)',
      createdBy: SYSTEM_USER_ID,
    };
    await client.documentTemplateVersion.upsert({ where: { id: item.versionId }, update: version, create: version });
  }
}

/**
 * Seed the SYSTEM reference library. The per-tenant clone is NOT here: phase 26
 * (`provisionTenantReferenceSet`) owns provisioning for every kind, this one
 * included, so the seed has one copier to keep in step with the runtime service
 * rather than two.
 */
export const seedDocumentTemplateLibrary = async (client: CorePrismaClient): Promise<void> => {
  console.log('Seeding the platform document-template reference library ...');

  await seedSystemLibrary(client);
  console.log(
    `  SYSTEM: ${DOCUMENT_TEMPLATE_LIBRARY.length} reference template(s) + v1 snapshot(s) [${DOCUMENT_TEMPLATE_LIBRARY.map((t) => t.slug).join(', ')}]`,
  );
  console.log('  (tenant copies are provisioned by 26-tenant-reference-set)');
};
