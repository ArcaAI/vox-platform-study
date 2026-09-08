import type { CorePrismaClient } from '../../../client';
import { Prisma } from '../../../generated/core-prisma-client/client';
import type { PromptTemplateCategory, PromptTemplateStatus } from '../../../generated/core-prisma-client/enums';
import { SEED_DEPARTMENT_IDS, SYSTEM_TENANT_ID } from './00-constants';

/**
 * Publication baseline.
 *
 * Templates default to DRAFT in the DB, but the clinician resolution path
 * (`PromptManagementService.listAvailableForCaller`) filters TENANT_DEFAULT /
 * DEPARTMENT_DEFAULT scopes to `status != DRAFT`, so a DRAFT-only seed left
 * clinicians with NO selectable prompts. We PUBLISH every clinician-facing
 * template and keep only `DNA_ANALYSIS` templates as DRAFT for realism — the
 * DNA writing-style service resolves its templates WITHOUT a publication gate,
 * so leaving them DRAFT keeps DNA working while still demonstrating a mixed
 * draft/published catalog in the admin console.
 */
// clinical-flow resolution is now approval-gated
// (`prompt-resolution.service` only resolves APPROVED templates). Seed clinician-
// facing templates directly as APPROVED so a freshly-seeded dev DB resolves the
// built-in catalog; DNA_ANALYSIS stays DRAFT (not a clinical generation flow).
const resolvePromptStatus = (category: string): PromptTemplateStatus => (category === 'DNA_ANALYSIS' ? 'DRAFT' : 'APPROVED') as PromptTemplateStatus;

/**
 * Publication state a seeded row is written with — status AND the version the
 * approval pins.
 *
 * An APPROVED row MUST pin a version. `PromptResolutionService` serves the
 * `PromptVersion` snapshot at `approvedVersionNumber`, never the mutable
 * `content` column, so `APPROVED` + `approvedVersionNumber: null` is a row
 * clinical resolution SKIPS while the console reads "Approved · not approved".
 * Sixteen seeded rows shipped that way (TASK-890 black-box J2-7) — including
 * "ArcaAI SOAP Summary", the ARCAAI tenant's department-agnostic summary
 * FALLBACK, so the fallback could not serve.
 *
 * The pin defaults to the row's current version (every seeded template has a
 * `PromptVersion` row at that number); a literal that names its own pin — e.g.
 * a row deliberately serving an older snapshot — keeps it.
 */
export const resolvePromptPublication = (template: {
  category: string;
  currentVersionNumber?: number;
  approvedVersionNumber?: number | null;
}): { status: PromptTemplateStatus; approvedVersionNumber: number | null } => {
  const status = resolvePromptStatus(template.category);
  const declared = template.approvedVersionNumber ?? null;
  if (status !== 'APPROVED') return { status, approvedVersionNumber: declared };
  return { status, approvedVersionNumber: declared ?? template.currentVersionNumber ?? 1 };
};

/**
 * TASK-890 §3.6 (OD-K) — `PromptTemplate.variables` / `PromptVersion.variables`
 * now store a typed declaration ARRAY (`{ name, type, required }[]`), not the
 * pre-ticket `{ [name]: { type, required } }` map every literal below still
 * reads as (kept for readability; the wrapper converts it once at module
 * load). There is NO read-side normaliser for the map any more, so every
 * `variables:` literal in this file is written through one of these two
 * converters.
 */
function declareTypedVariables(
  map: Record<string, { type: 'string' | 'number' | 'boolean' | 'date' | 'json'; required: boolean }>,
): Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'date' | 'json'; required: boolean }> {
  return Object.entries(map).map(([name, def]) => ({ name, type: def.type, required: def.required }));
}

/**
 * Converts the simpler `{ [name]: 'description' }` map (the legacy shape used
 * by informational/assembler-substituted placeholders, e.g. the v1 pre-summary
 * names) into the same typed declaration array — always `type: 'string'`,
 * `required: true` (these were never left unsubstituted; the test bench now
 * asks the admin to supply a sample value the same way the consultation
 * assembler always supplied one).
 */
function declareDescribedVariables(map: Record<string, string>): Array<{ name: string; type: 'string'; required: true; description: string }> {
  return Object.entries(map).map(([name, description]) => ({ name, type: 'string' as const, required: true as const, description }));
}

export const DEFAULT_TENANT_ID = '50000000-0000-0000-0000-000000000000';
export const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';

/**
 * Structured SOAP output schema.
 *
 * Seeded into the SOAP template's `metaData.promptConfig.outputSchema` so
 * `PromptAssemblyService.assemble()` emits a non-null `responseFormat`
 * (`{ type: 'json_schema', json_schema, strict: true }`). For non-Ollama
 * providers `buildTextGeneratePayload()` then forwards it as `response_format`,
 * activating constrained SOAP generation end-to-end.
 */
export const SOAP_OUTPUT_SCHEMA = {
  title: 'SOAPNote',
  type: 'object',
  additionalProperties: false,
  properties: {
    subjective: { type: 'string', description: 'Patient history, chief complaint, HPI, review of systems.' },
    objective: { type: 'string', description: 'Vitals, physical exam findings, labs, imaging.' },
    assessment: {
      type: 'string',
      description:
        'Primary diagnosis, differentials, severity grading — by name; do not write, guess, or transcribe a diagnostic code in this field — codes are attached separately from a verified terminology source.',
    },
    plan: { type: 'string', description: 'Medications with dosages, referrals, follow-up timeline, patient education.' },
  },
  required: ['subjective', 'objective', 'assessment', 'plan'],
};

/** SOAP prompt hyperparameters + output schema, persisted under `metaData.promptConfig`. */
export const SOAP_PROMPT_CONFIG = {
  hyperparameters: { temperature: 0.0, max_tokens: 65536, top_p: 0.95 },
  outputSchema: SOAP_OUTPUT_SCHEMA,
};

/**
 * Structured DNA writing-style output schema ( PHI containment).
 *
 * Every property is a CLOSED vocabulary (enum) or a short, headings-only
 * string — deliberately with NO free-text field wide enough to carry a
 * quoted clinical sentence, patient name, or identifier. This is the
 * structural fix: even a model that ignores its instructions cannot smuggle
 * verbatim patient content through a field whose only valid values are
 * `'active' | 'passive' | 'mixed'` etc. `DnaWritingStyleProcessor` additionally
 * validates the parsed response against `required` before accepting it (belt
 * and suspenders — never trust `strict: true` alone).
 */
export const DNA_OUTPUT_SCHEMA = {
  title: 'DnaStyleProfile',
  type: 'object',
  additionalProperties: false,
  properties: {
    sentenceStructure: { type: 'string', enum: ['active', 'passive', 'mixed'], description: 'Predominant sentence voice.' },
    verbosity: { type: 'string', enum: ['terse', 'moderate', 'verbose'], description: 'Overall level of documentation detail.' },
    listVsNarrative: { type: 'string', enum: ['list', 'narrative', 'mixed'], description: 'Preference for bulleted lists vs prose paragraphs.' },
    sectionOrderPreference: {
      type: 'string',
      maxLength: 200,
      description:
        'Comma-separated section HEADINGS only, in preferred order (e.g. "Subjective, Objective, Assessment, Plan") — never a sentence, and never patient-specific content.',
    },
    abbreviationFrequency: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How often standard medical abbreviations are used.' },
    toneFormality: { type: 'string', enum: ['casual', 'neutral', 'formal'], description: 'Overall tone and formality level.' },
    confidenceScores: {
      type: 'object',
      description: 'Confidence (0-1) per extracted pattern, keyed by the property name it scores.',
      additionalProperties: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
  required: [
    'sentenceStructure',
    'verbosity',
    'listVsNarrative',
    'sectionOrderPreference',
    'abbreviationFrequency',
    'toneFormality',
    'confidenceScores',
  ],
};

/** DNA prompt hyperparameters + output schema, persisted under `metaData.promptConfig`. */
export const DNA_PROMPT_CONFIG = {
  hyperparameters: { temperature: 0.0, max_tokens: 8192, top_p: 0.95 },
  outputSchema: DNA_OUTPUT_SCHEMA,
};

/**
 * DNA_ANALYSIS prompt content, v3. Defense-in-depth over the
 * schema (`DNA_PROMPT_CONFIG.outputSchema`): an explicit instruction against
 * reproducing patient content, even though the structural fix is the closed
 * schema, not this sentence.
 */
export const DNA_ANALYSIS_CONTENT_V3 =
  "Analyze the physician's writing style from the provided consultation transcripts and summaries.\n\nExtract patterns for:\n1. Sentence structure preferences (active/passive, length, complexity)\n2. Medical terminology usage (formal vs colloquial, abbreviation frequency)\n3. Documentation style (narrative vs structured, level of detail)\n4. Common phrases and transition words\n5. Section ordering preferences\n6. Tone and formality level\n\nOutput a structured DNA profile that can be used to generate future summaries matching this physician's style. Include confidence scores for each extracted pattern.\n\nDo not reproduce, quote, or paraphrase any patient name, identifier, date, medication, dose, or other encounter-specific fact from the source material — describe stylistic patterns only, never patient content.";

// Template IDs - exported for cross-referencing in other seeds
export const TEMPLATE_IDS = {
  SYSTEM_DEFAULT: '71000000-0000-0000-0000-000000000001',
  SOAP_SUMMARY: '71000000-0000-0000-0000-000000000002',
  DNA_ANALYSIS: '71000000-0000-0000-0000-000000000003',
  CARD_CUSTOM: '71000000-0000-0000-0000-000000000004',
  TEXT_SYSTEM_BASE: '71000000-0000-0000-0000-000000000005',
  TEXT_SYSTEM_ER: '71000000-0000-0000-0000-000000000006',
  TEXT_SYSTEM_PEDS: '71000000-0000-0000-0000-000000000007',
  TEXT_SYSTEM_CARD: '71000000-0000-0000-0000-000000000008',
  TEXT_SYSTEM_PSYCH: '71000000-0000-0000-0000-000000000009',
  JSON_ENFORCEMENT: '71000000-0000-0000-0000-000000000024',
  CORRECTIVE_RETRY: '71000000-0000-0000-0000-000000000025',
  PRE_SUMMARY_SYSTEM: '71000000-0000-0000-0000-000000000026',
  PREVIOUS_VISIT_SYSTEM: '71000000-0000-0000-0000-000000000027',
  CATCHALL_SOAP: '71000000-0000-0000-0000-000000000036',
  PRE_SUMMARY_DEFAULT: '71000000-0000-0000-0000-000000000040',
  // ---------------------------------------------------------------------------
  // GENERIC platform templates for the eight care-setting departments
  // (04-department.ts). Authored for OD-8: the previous Global
  // catalog reused BCMCH's v1 specialty prompt bodies, which the golden library
  // then shipped to every new tenant. These are written to the standard
  // clinical-documentation section conventions instead and name no
  // organisation, house format, or specialty roster.
  //
  // Block 0003 mirrors the department id block of the same number.
  GENERIC_OUTPATIENT_NEW: '71000000-0000-0000-0003-000000000001',
  GENERIC_OUTPATIENT_REVISIT: '71000000-0000-0000-0003-000000000002',
  GENERIC_INPATIENT_ADMISSION: '71000000-0000-0000-0003-000000000003',
  GENERIC_INPATIENT_PROGRESS: '71000000-0000-0000-0003-000000000004',
  GENERIC_EMERGENCY_ENCOUNTER: '71000000-0000-0000-0003-000000000005',
  GENERIC_PERIOP_ASSESSMENT: '71000000-0000-0000-0003-000000000006',
  GENERIC_PERIOP_REVIEW: '71000000-0000-0000-0003-000000000007',
  GENERIC_IMAGING_REPORT: '71000000-0000-0000-0003-000000000008',
  GENERIC_LAB_REPORT: '71000000-0000-0000-0003-000000000009',
  GENERIC_BEHAVIORAL_ASSESSMENT: '71000000-0000-0000-0003-000000000010',
  GENERIC_BEHAVIORAL_REVIEW: '71000000-0000-0000-0003-000000000011',
  GENERIC_PEDIATRIC_NEW: '71000000-0000-0000-0003-000000000012',
  GENERIC_PEDIATRIC_REVISIT: '71000000-0000-0000-0003-000000000013',
  // Lane N — the PLATFORM DEFAULT instruction and grounding policy.
  //
  // SYSTEM-tenant rows, and that placement is the whole point rather than a filing choice.
  // `00-project-context.md` §Configuration Principles forbids these bodies from being literals in
  // code or env, and prescribes exactly this: "the SYSTEM-tenant rows a platform admin writes are
  // the FALLBACK for tenants with no opinion". `PromptTemplate`/`PromptVersion` are
  // SYSTEM_SHARED_READ_MODELS, so every tenant can resolve them while a tenant that authors its
  // own template simply binds that id on its node instead — tenant -> SYSTEM, expressed as a
  // binding rather than a cascade.
  IMPORTANT_FINDINGS_SYSTEM: '71000000-0000-0000-0000-000000000041',
  GROUNDING_POLICY_SYSTEM: '71000000-0000-0000-0000-000000000042',
  // the LIVE GRAMMAR instruction, and the same tier for the same reason.
  //
  // `agent.grammar` was registered by Lane R and seeded by nothing, so the live grammar pass ran
  // for no tenant. Seeding the NODE alone would not have changed that: the realtime handler
  // resolves its system prompt from the node's `promptTemplateId` and THROWS when it is unbound,
  // so an unbound node degrades on every flush — "runs for nobody" in a different costume.
  LIVE_GRAMMAR_SYSTEM: '71000000-0000-0000-0000-000000000043',
  // the DURABLE note-level correction instruction, and the same tier for the same
  // reason.
  //
  // `consultation.proposeCorrections` ran on `_CORRECTION_SYSTEM_PROMPT`, a Python constant, while
  // the realtime sibling of the SAME engine already resolved a governed template. A tenant could
  // not read, change or version-pin how its own notes were corrected.
  //
  // It is a SEPARATE row from LIVE_GRAMMAR_SYSTEM rather than a shared one, and the difference is
  // the material each pass reviews. `agent.grammar.in` is `transcript` — a PARTIAL one that grows
  // between turns, which is why that body says "do not correct a word that is merely cut off at
  // the end". `consultation.proposeCorrections.in` is `text`, and in both seeded graphs it is fed
  // from `consultation.synthesize`: a FINISHED, complete note. An instruction telling a model the
  // note is still growing would be wrong about the only thing it needs to be right about.
  NOTE_CORRECTIONS_SYSTEM: '71000000-0000-0000-0000-000000000044',
  // the platform default for `consultation.suggestions` (W2), the sibling defect of
  // …044's. It is a THIRD body rather than a reuse of either neighbour, and the difference is
  // what the pass is for. …043 and …044 both REVIEW existing words for error — one in a partial
  // transcript, one in a finished note — and neither may add clinical content. This pass adds:
  // it proposes questions, checks and omissions that are NOT in the text. An instruction built
  // around "correct only what is genuinely wrong, add nothing" is the exact opposite of what
  // this node needs to be told.
  LIVE_SUGGESTIONS_SYSTEM: '71000000-0000-0000-0000-000000000045',
  WHISPER_INITIAL_PROMPT_EN_VI: '71000000-0000-0000-0000-000000000050',
  // TASK-930 §8.3 — the General Medicine consultation summary the `general-medicine-summarization`
  // agent binds. Global AUTHORS it (this id); SYSTEM carries the promoted copy
  // (`SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID`, `sourceTemplateId` → this row).
  GENERAL_MEDICINE_CONSULTATION_SUMMARY: '71000000-0000-0000-0000-000000000051',
} as const;

// Version IDs
const VERSION_IDS = {
  V01: '72000000-0000-0000-0000-000000000001',
  V02: '72000000-0000-0000-0000-000000000002',
  V03: '72000000-0000-0000-0000-000000000003',
  V04: '72000000-0000-0000-0000-000000000004',
  V05: '72000000-0000-0000-0000-000000000005',
  V06: '72000000-0000-0000-0000-000000000006',
  V07: '72000000-0000-0000-0000-000000000007',
  V08: '72000000-0000-0000-0000-000000000008',
  V09: '72000000-0000-0000-0000-000000000009',
  V10: '72000000-0000-0000-0000-000000000010',
  V11: '72000000-0000-0000-0000-000000000011',
  V12: '72000000-0000-0000-0000-000000000012',
  V13: '72000000-0000-0000-0000-000000000013',
  V14: '72000000-0000-0000-0000-000000000014',
  V15: '72000000-0000-0000-0000-000000000015',
  V16: '72000000-0000-0000-0000-000000000016',
  V17: '72000000-0000-0000-0000-000000000017',
  V18: '72000000-0000-0000-0000-000000000018',
  V19: '72000000-0000-0000-0000-000000000019',
  V20: '72000000-0000-0000-0000-000000000020',
  V21: '72000000-0000-0000-0000-000000000021',
  V22: '72000000-0000-0000-0000-000000000022',
  V23: '72000000-0000-0000-0000-000000000023',
  V24: '72000000-0000-0000-0000-000000000024',
  V25: '72000000-0000-0000-0000-000000000025',
  V26: '72000000-0000-0000-0000-000000000026',
  V27: '72000000-0000-0000-0000-000000000027',
  V28: '72000000-0000-0000-0000-000000000028',
  V29: '72000000-0000-0000-0000-000000000029',
  V30: '72000000-0000-0000-0000-000000000030',
  V31: '72000000-0000-0000-0000-000000000031',
  V32: '72000000-0000-0000-0000-000000000032',
  V33: '72000000-0000-0000-0000-000000000033',
  V34: '72000000-0000-0000-0000-000000000034',
  V35: '72000000-0000-0000-0000-000000000035',
  V36: '72000000-0000-0000-0000-000000000036',
  V37: '72000000-0000-0000-0000-000000000037',
  V38: '72000000-0000-0000-0000-000000000038',
  V39: '72000000-0000-0000-0000-000000000039',
  V40: '72000000-0000-0000-0000-000000000040',
  V41: '72000000-0000-0000-0000-000000000041',
  V42: '72000000-0000-0000-0000-000000000042',
  V43: '72000000-0000-0000-0000-000000000043',
  V44: '72000000-0000-0000-0000-000000000044',
  V45: '72000000-0000-0000-0000-000000000045',
  V46: '72000000-0000-0000-0000-000000000046',
  V47: '72000000-0000-0000-0000-000000000047',
  V48: '72000000-0000-0000-0000-000000000048',
  V49: '72000000-0000-0000-0000-000000000049',
  V50: '72000000-0000-0000-0000-000000000050',
  V51: '72000000-0000-0000-0000-000000000051',
} as const;

// Global-tenant department IDs. Re-exported from 00-constants rather than
// re-declared as literals: `PromptTemplate.departmentId` is a REAL Postgres FK
// (prompt-template.prisma), so a literal that drifts from the department seed is
// a failed migration, not a stale comment.
const DEPT = SEED_DEPARTMENT_IDS;

// Content constants from Python sources (exact copy)
const TEXT_SYSTEM_BASE_CONTENT = `You are an expert medical AI assistant specialized in analyzing medical conversations between healthcare providers and patients. Your role is to create clear, accurate, and clinically relevant summaries in structured JSON format with markdown-formatted content.

Key responsibilities:
- Extract all clinically significant information accurately
- Identify symptoms with details about onset, duration, severity
- Document relevant medical history, medications, and allergies
- Note examination findings and vital signs
- Capture diagnostic reasoning and treatment plans
- Include follow-up recommendations and warning signs
- Maintain medical accuracy and use standard terminology
- Flag any safety concerns or urgent findings

LANGUAGE REQUIREMENTS:
- CRITICAL: Always respond in CONVERSATION LANGUAGE
- Maintain consistent language throughout all JSON fields and content
- Use appropriate medical terminology in the target language
- Do not mix languages within the response

FORMATTING REQUIREMENTS:
- Always respond with valid JSON format as specified in the user prompt
- Format ALL text content within JSON fields using markdown syntax
- Use headers (##), bold (**text**), lists (- item), and emphasis for structure
- Do not include any text outside the JSON structure
- Use "**Not documented**" (or equivalent in target language) for any information not available in the conversation

Always prioritize patient safety and clinical accuracy in your summaries.`;

const JSON_ENFORCEMENT_NOTE = `CRITICAL OUTPUT CONSTRAINTS:
- Return ONLY a single JSON object. No preface, no explanation, no trailing text.
- Follow the schema defined by the active prompt/template (department/visit-specific where applicable).
- Do NOT invent fields that are not specified by the prompt/template schema.
- ALL field values MUST be strings (markdown formatted text). Do NOT return nested objects or arrays as field values.
- All text content (including section headings/labels inside values) MUST be in the conversation language and formatted using markdown.
- Do NOT use placeholders like 'Not documented' / 'Summary not available' (or their equivalents in the conversation language) for the 'summary' field. Always provide a concise, best‑effort summary from available information.
- If truly no data exists for a non-summary field, write a succinct statement in the conversation language (avoid literal 'Not documented').
- Ensure valid JSON (double-quoted keys/strings, no trailing commas).
`;

const CORRECTIVE_RETRY_SUFFIX = `\n\nREVISE STRICTLY:
- Do NOT use placeholders like 'Not documented' or 'Summary not available' (or their equivalents in the conversation language).
- Monolingual rule: All headings/labels and descriptive content inside values MUST be in the conversation language. Do NOT include any English words inside values.
- Respond ONLY with a valid single JSON object (no pre/post text).
- Provide a best‑effort concise summary from available information.`;

const PRE_SUMMARY_SYSTEM_PROMPT = `You are a medical AI assistant producing clinically relevant, concise, department-aware pre-summaries from EMR context. Format your response with clear sections and bullet points for readability. Include main sections for: Confirmed & Provisional Diagnoses, Plan of Care, Investigations, Medications Prescribed, and Diagnostics & Trends.`;

/**
 * SYSTEM default pre-summary body (`TEMPLATE_IDS.PRE_SUMMARY_DEFAULT`, seeded
 * to the GLOBAL customer tenant, consumed platform-wide as
 * `SYSTEM_DEFAULTS.preSummaryPromptId` tier-2 fallback for pre-summary
 * resolution). Extracted into a named constant (pure refactor, byte-identical)
 * so `system-pre-summary-default-checksum.test.ts`
 * (packages/database/src/__tests__/) can sha256-lock it against silent drift.
 *
 * This is a HAND-MAINTAINED NEAR-DUPLICATE of the v1-parity ArcaAI pre-summary
 * body (`PRE_SUMMARY_CONTENT` in `07b-arcaai-clinical-content.ts`, itself
 * checksum-locked by `v1-clinical-prompt-fidelity.test.ts`). The two are
 * NOT the same constant and are NOT kept in sync automatically — do not edit
 * one without consciously deciding whether the other needs the same change
 * . Do NOT add this constant to the 15-entry ArcaAI fidelity
 * fixture; that fixture asserts exactly 15 entries with v1-pod provenance and
 * this constant has none.
 */
export const SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT = `## Medical AI Pre-Summary Prompt

> **You are a medical AI assistant tasked with creating a CRISP, CLINICALLY-RELEVANT pre-summary from multiple data sources.

Do not carry over information from any other patient. Treat each request independently..**

---

### ** Contextual data is provided by **

- **Department:** {{context.current_department}}

- **Visit Type:** {{context.visit_type}}

- **Demographics:** Age {{context.safe_age}}, DOB {{context.safe_dob}}, Gender {{context.safe_gender}}

- **Recent Vitals:** {{context.safe_vitals}} (two most recent encounters)

- **Test Results:** {{context.formatted_test_results}}

- **Previous Visits:** {{context.formatted_previous_visits}}

---

## REQUIREMENTS

### PRIORITIZE:

- Notes from {{context.current_department}}

- Most recent encounters

### CAPTURE:

- All provisional and confirmed diagnoses mentioned in any past case note

- The Plan of Care from the latest note in the current department, documented in full

- All investigation results reported in the latest department note

- All medications prescribed in the latest department note, including doses and schedules

### INCLUDE ONLY clinically significant items:

- Active or ongoing conditions

- Key treatments and responses

- Current medications and tolerance

- Important test results or procedures

- Allergies/contraindications

- Notable trends (e.g., weight changes, lab trajectories)

### EXCLUDE:

- Routine follow-ups without new findings

- Minor resolved complaints

- Administrative text

- Repetitive details

### STYLE:

- Use bullet points

- Group by clinical importance, not strictly chronology

- Maintain brevity: keep each bullet to one sentence or phrase

- Language: {{context.language_name}}

### INSTRUCTIONS

- Use the following section headers EXACTLY as written (in English) and do NOT translate them.
- Write ALL bullet content in {{context.language_name}}, including any text inside parentheses.
- Translate ALL English descriptors from context into {{context.language_name}}
- Translate ALL text that appears in parentheses into {{context.language_name}}
- Parentheses Localization Policy: For any parentheses that contain English words, translate them into {{context.language_name}}. If a direct translation is unclear, paraphrase briefly in {{context.language_name}}. Only leave English inside parentheses for standard clinical abbreviations (BP, HR, RR, Temp, SpO2) and measurement units (°C, mmHg, mg, ml).
- Do NOT include English words in bullet items or parentheses, except for:
- Standard clinical abbreviations (e.g., BP, HR, RR, Temp, SpO2)
- Measurement units (e.g., °C, mmHg, mg, ml)
- Before finalizing, perform a self-check: scan every pair of parentheses and ensure there are no English words inside (except the allowed abbreviations/units). If any are found, replace them with {{context.language_name}} equivalents.
- Translate or localize any status or qualifier terms or any text inside parentheses into {{context.language_name}}.

---

## FORMAT

Pre-Summary of Medical History  

- Confirmed & Provisional Diagnoses:  

- Plan of Care (Latest Department Note):  

- Investigations (Latest Department Note):  

- Medications Prescribed (Latest Department Note):  

- Diagnostics & Trends:

---

Now generate the pre-summary.`;

export const DEFAULT_PROMPT_TEMPLATES = [
  // ID 01: System Default Prompt (existing)
  {
    id: TEMPLATE_IDS.SYSTEM_DEFAULT,
    tenantId: DEFAULT_TENANT_ID,
    name: 'System Default Prompt',
    description: 'Default system prompt for general medical documentation',
    content:
      'You are a clinical documentation assistant. Generate accurate, concise medical notes based on the consultation. Use standard medical terminology and maintain patient confidentiality. Format output according to the specified template.',
    category: 'SYSTEM',
    variables: declareTypedVariables({
      patient_name: { type: 'string', required: true },
      department: { type: 'string', required: false },
    }),
    currentVersionNumber: 1,
    departmentId: null,
    tags: [],
  },
  // ID 02: SOAP Summary Prompt (existing)
  {
    id: TEMPLATE_IDS.SOAP_SUMMARY,
    tenantId: DEFAULT_TENANT_ID,
    name: 'SOAP Summary Prompt',
    description: 'SOAP format clinical summary for progress notes',
    content:
      'Generate a SOAP-format clinical summary with enhanced structure.\n\nInclude:\n- Subjective: patient history, chief complaint, HPI, review of systems\n- Objective: vitals, physical exam findings, labs, imaging\n- Assessment: primary diagnosis, differentials, severity grading — by name; do not write, guess, or transcribe a diagnostic code in this field — codes are attached separately from a verified terminology source\n- Plan: medications with dosages, referrals, follow-up timeline, patient education\n\nUse concise clinical language. Flag critical values. Include confidence levels for differential diagnoses.',
    category: 'SUMMARY',
    variables: declareTypedVariables({
      patient_name: { type: 'string', required: true },
      chief_complaint: { type: 'string', required: true },
      department: { type: 'string', required: false },
      severity: { type: 'string', required: false },
    }),
    // Activate structured SOAP output (json_schema).
    metaData: { promptConfig: SOAP_PROMPT_CONFIG } as Prisma.InputJsonValue,
    // bumped 3 -> 4 — v4 (EXTRA_PROMPT_VERSIONS id …0105) removes the
    // free-text ICD-10 instruction. v3's PromptVersion snapshot is preserved
    // unmutated (see comment there) since it is a historical record of what
    // was actually served, not a live instruction.
    currentVersionNumber: 4,
    departmentId: null,
    tags: ['soap', 'clinical'],
  },
  // ID 03: DNA Writing Style Analysis Prompt (existing)
  {
    id: TEMPLATE_IDS.DNA_ANALYSIS,
    tenantId: DEFAULT_TENANT_ID,
    name: 'DNA Writing Style Analysis Prompt',
    description: 'Prompt for analyzing doctor writing style patterns',
    content: DNA_ANALYSIS_CONTENT_V3,
    category: 'DNA_ANALYSIS',
    variables: declareTypedVariables({
      physician_id: { type: 'string', required: true },
      sample_count: { type: 'number', required: false },
    }),
    // Constrain DNA output to the closed-vocabulary schema ( PHI
    // containment) — same mechanism as SOAP_PROMPT_CONFIG above.
    metaData: { promptConfig: DNA_PROMPT_CONFIG } as Prisma.InputJsonValue,
    currentVersionNumber: 3,
    departmentId: null,
    tags: ['dna', 'writing-style', 'analysis'],
  },
  // ID 04: Cardiology Department Prompt (existing)
  {
    id: TEMPLATE_IDS.CARD_CUSTOM,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Cardiology Department Prompt',
    description: 'Specialized prompt for cardiology consultations',
    content:
      'Generate cardiology-specific clinical documentation. Include cardiac history, relevant vitals (BP, HR, rhythm), ECG findings when applicable, and cardiovascular examination. Use cardiology-standard terminology and abbreviations (e.g., LVEF, NYHA, STEMI).',
    category: 'CUSTOM',
    variables: declareTypedVariables({
      patient_name: { type: 'string', required: true },
      cardiac_history: { type: 'string', required: false },
      ecg_results: { type: 'string', required: false },
    }),
    currentVersionNumber: 1,
    departmentId: null,
    tags: [],
  },
  // ID 05: SMR System Prompt - Base
  {
    id: TEMPLATE_IDS.TEXT_SYSTEM_BASE,
    tenantId: DEFAULT_TENANT_ID,
    name: 'SMR System Prompt - Base',
    description: 'Base system prompt for SMR medical conversation summarization',
    content: TEXT_SYSTEM_BASE_CONTENT,
    category: 'SYSTEM',
    variables: null,
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['system', 'base', 'text-v1'],
  },
  // ID 06: SMR System Prompt - Emergency Medicine
  {
    id: TEMPLATE_IDS.TEXT_SYSTEM_ER,
    tenantId: DEFAULT_TENANT_ID,
    name: 'SMR System Prompt - Emergency Medicine',
    description: 'Emergency medicine specialty overlay for SMR',
    content: `\nEMERGENCY MEDICINE FOCUS:
- Assess triage acuity and time-sensitive interventions
- Document critical pathways and disposition decisions
- Flag critical values requiring immediate intervention
- Note trauma mechanisms or toxicological concerns
- Include emergency-specific vital signs interpretation`,
    category: 'SYSTEM',
    variables: null,
    currentVersionNumber: 1,
    departmentId: DEPT.ER,
    tags: ['system', 'specialty', 'emergency', 'text-v1'],
  },
  // ID 07: SMR System Prompt - Pediatrics
  {
    id: TEMPLATE_IDS.TEXT_SYSTEM_PEDS,
    tenantId: DEFAULT_TENANT_ID,
    name: 'SMR System Prompt - Pediatrics',
    description: 'Pediatrics specialty overlay for SMR',
    content: `\nPEDIATRIC MEDICINE FOCUS:
- Document age-appropriate vital sign interpretation
- Include growth parameters and developmental milestones
- Assess behavioral observations and family dynamics
- Review immunization status and preventive care
- Use pediatric-specific terminology and dosing`,
    category: 'SYSTEM',
    variables: null,
    currentVersionNumber: 1,
    departmentId: DEPT.PEDS,
    tags: ['system', 'specialty', 'pediatrics', 'text-v1'],
  },
  // ID 08: SMR System Prompt - Cardiology
  {
    id: TEMPLATE_IDS.TEXT_SYSTEM_CARD,
    tenantId: DEFAULT_TENANT_ID,
    name: 'SMR System Prompt - Cardiology',
    description: 'Cardiology specialty overlay for SMR',
    content: `\nCARDIOLOGY FOCUS:
- Detailed cardiovascular risk factor assessment
- ECG interpretation and cardiac rhythm analysis
- Hemodynamic parameters and functional capacity
- Cardiac imaging and diagnostic test interpretation
- Exercise tolerance and activity recommendations`,
    category: 'SYSTEM',
    variables: null,
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['system', 'specialty', 'cardiology', 'text-v1'],
  },
  // ID 09: SMR System Prompt - Psychiatry
  {
    id: TEMPLATE_IDS.TEXT_SYSTEM_PSYCH,
    tenantId: DEFAULT_TENANT_ID,
    name: 'SMR System Prompt - Psychiatry',
    description: 'Psychiatry specialty overlay for SMR',
    content: `\nMENTAL HEALTH FOCUS:
- Comprehensive mental status examination
- Assess suicide and violence risk with safety planning
- Document psychosocial stressors and support systems
- Include substance use screening and assessment
- Evaluate functional capacity and cognitive status`,
    category: 'SYSTEM',
    variables: null,
    currentVersionNumber: 1,
    departmentId: DEPT.BEH,
    tags: ['system', 'specialty', 'psychiatry', 'text-v1'],
  },
  // ID 10: Surgery - New Referral
  // ID 11: Surgery - Revisit
  // ID 12: General Medicine - New Referral
  // ID 13: General Medicine - Revisit
  // ID 14: Breast & Endocrine - New Referral
  // ID 15: Breast & Endocrine - Revisit
  // ID 16: Rheumatology - New Referral
  // ID 17: Rheumatology - Revisit
  // ID 18: Orthopedics - New Referral
  // ID 19: Orthopedics - Revisit
  // ID 20: Neurology - New Referral
  // ID 21: Neurology - Revisit
  // ID 22: Hematology - New Referral
  // ID 23: Hematology - Revisit
  // ID 24: JSON Enforcement Note
  {
    id: TEMPLATE_IDS.JSON_ENFORCEMENT,
    tenantId: DEFAULT_TENANT_ID,
    name: 'JSON Enforcement Note',
    description: 'Critical output constraints for strict JSON-only responses',
    content: JSON_ENFORCEMENT_NOTE,
    category: 'SYSTEM',
    variables: null,
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['system', 'json-enforcement', 'text-v1'],
  },
  // ID 25: Corrective Retry Suffix
  {
    id: TEMPLATE_IDS.CORRECTIVE_RETRY,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Corrective Retry Suffix',
    description: 'Retry prompt when initial response contains placeholders or invalid JSON',
    content: CORRECTIVE_RETRY_SUFFIX,
    category: 'SYSTEM',
    variables: null,
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['system', 'retry', 'text-v1'],
  },
  // ID 26: Pre-Summary System Prompt
  {
    id: TEMPLATE_IDS.PRE_SUMMARY_SYSTEM,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Pre-Summary System Prompt',
    description: 'System prompt for department-aware pre-summary generation from EMR context',
    content: PRE_SUMMARY_SYSTEM_PROMPT,
    category: 'SYSTEM',
    variables: null,
    currentVersionNumber: 1,
    departmentId: null,
    // NOTE (/ OD-4b): deliberately NOT tagged `pre-summary`. This
    // is a system-role stub, not the tenant's pre-summary default; carrying the
    // tag made it a second candidate for `findTenantPreSummaryTemplateId`'s
    // tag-convention lookup alongside `PRE_SUMMARY_DEFAULT` (…040) below, and the
    // multi-candidate tiebreak (createdAt/id order) silently served this stub
    // instead of the intended default. See
    // pre-summary-candidate-uniqueness.test.ts.
    tags: ['system', 'text-v1'],
  },
  // ID 27: Previous Visit Summary System Prompt
  {
    id: TEMPLATE_IDS.PREVIOUS_VISIT_SYSTEM,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Previous Visit Summary System Prompt',
    description: 'System prompt for previous visit analysis',
    content: 'You are a medical assistant analyzing previous visit information.',
    category: 'SYSTEM',
    variables: null,
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['system', 'previous-visit', 'text-v1'],
  },
  // Unified Pre-Summary Template (tenant-level default for all departments)
  //
  // NOTE (C2): this is the SYSTEM_DEFAULTS.preSummaryPromptId
  // platform-wide fallback, and it is now owned by the SYSTEM tenant — NOT the
  // GLOBAL customer tenant it was seeded under originally. It had to move:
  // PromptTemplate is tenant-scoped, the read handler injects the CALLER's
  // tenantId, so a Global-owned row was invisible to every other tenant and the
  // pre-summary chain's tier-2 fell through to its 503 fail-closed instead of
  // this fallback. SYSTEM ownership + the PromptTemplate/PromptVersion entry in
  // SYSTEM_SHARED_READ_MODELS (extensions/tenant-scope.ts) widens READS to
  // `tenantId IN [caller, SYSTEM]`; writes are NOT widened, so no tenant can
  // mutate it. Matching data migration:
  // migrations/20260808000100_task_635_reown_system_pre_summary_default.
  //
  // `approvedVersionNumber: 1` is an integrity upgrade, not a content change:
  // the resolver then serves the immutable V40 PromptVersion snapshot rather
  // than the mutable `content` column via resolveGovernedContent's legacy
  // fallback. The two are byte-identical here by construction.
  //
  // Its content (`SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT`, declared above) is
  // sha256-locked against silent drift by
  // packages/database/src/__tests__/system-pre-summary-default-checksum.test.ts.
  {
    id: TEMPLATE_IDS.PRE_SUMMARY_DEFAULT,
    tenantId: SYSTEM_TENANT_ID,
    approvedVersionNumber: 1,
    name: 'Pre-Summary Default Template',
    description: 'Unified pre-summary template for all departments. Uses {{context.current_department}} for department-aware prioritization.',
    content: SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT,
    category: 'SYSTEM',
    variables: declareDescribedVariables({
      current_department: 'Department name injected at runtime',
      visit_type: 'new-visit or revisit',
      safe_age: 'Patient age',
      safe_dob: 'Patient date of birth',
      safe_gender: 'Patient gender',
      safe_vitals: 'Recent vitals data',
      formatted_test_results: 'Formatted test results',
      formatted_previous_visits: 'Formatted previous visit summaries',
      language_name: 'Output language name',
    }),
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['pre-summary', 'system', 'unified', 'tenant-default'],
  },
  // ──────────────────────────────────────────────────────────────────
  // ID 43: Dermatology - New Referral
  // ──────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────
  // ID 44: Dermatology - Revisit
  // ──────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────
  // ID 45: Dietetics - New Referral
  // ──────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────
  // ID 46: Dietetics - Revisit
  // ──────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────
  // ID 47: Nephrology - New Referral
  // ──────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────
  // ID 48: Nephrology - Revisit
  // ──────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────
  // ID 49: Surgical Oncology - New Referral
  // ──────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────
  // ID 50: Surgical Oncology - Revisit
  // ──────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────
  // ID 51: Catch-All SOAP (fallback when no department matches)
  // ──────────────────────────────────────────────────────────────────
  {
    id: TEMPLATE_IDS.CATCHALL_SOAP,
    // owned by the SYSTEM tenant, NOT the GLOBAL customer tenant it was
    // seeded under originally. This row is `SYSTEM_DEFAULTS.promptId` in
    // prompt-resolution.service.ts — the platform-wide fallback every consultation
    // whose tenant/department expresses no SOAP opinion assembles from. The same
    // defect C2 fixed for PRE_SUMMARY_DEFAULT (…040) above: PromptTemplate is
    // tenant-scoped and reads widen only to `[caller, SYSTEM]`, so a Global-owned
    // row was invisible to every other tenant and `assemble` threw
    // DataNotFound → the durable lane's `n_prompt` degraded on every governed run
    // (measured on hope-v2-dev, 2026-09-03). `approvedVersionNumber: 1` mirrors
    // …040 so the resolver serves the immutable V15 snapshot. Matching data
    // migration for already-seeded databases:
    // migrations/20260903120000_task_858_reown_system_catchall_soap.
    tenantId: SYSTEM_TENANT_ID,
    approvedVersionNumber: 1,
    name: 'Catch-All SOAP',
    description: 'Fallback SOAP template used when no department-specific template matches the encounter',
    content: `[NOTE TO LLM:

- You are acting as a clinical documentation assistant, generating a structured medical note based strictly on:
  - The current doctor–patient conversation
  - The provided clinical context inputs (when present)
- Always respond in English.
- Write the note as if authored by the treating physician, using neutral, professional clinical language.
- Do not include AI opinions, suggestions, or commentary to the doctor.
- Do not introduce facts, diagnoses, plans, or interpretations that were not stated or clearly implied by the clinician.
- Avoid sycophantic phrasing, reassurance language, or speculative statements.
- Use context inputs to improve coherence and continuity, not to restate historical data unless clinically relevant to the current visit.
- If information is unavailable for a section or sub-item, omit it entirely.
- Document negative history only if explicitly mentioned in the conversation.
- Ensure clarity, relevance, and logical flow in line with SAIL documentation best practices.]

When no department-specific template matches the current encounter's department, OR the department is unrecognized/unspecified, produce a SOAP-format clinical summary using exactly these four headings in order:

**Subjective**
- Presenting complaints with duration
- Relevant symptom progression or changes since last visit
- Associated positive or negative symptoms (only if explicitly mentioned)
- Treatment adherence or response as stated by the patient
- Any concerns, expectations, or clarifications voiced during the encounter

**Objective**
- Relevant vital signs (if referenced or clinically pertinent)
- Examination findings explicitly stated during the encounter
- Investigation results discussed or reviewed (labs, imaging, reports)
- Objective data referenced from prior notes only if tied to today's discussion

**Assessment**
- Working diagnoses or clinical impressions stated or clearly implied
- Differential diagnoses discussed (if any)
- Clinical reasoning explicitly verbalized by the doctor
- Relationship to prior conditions or same-day continuation visits (if applicable)

**Plan**
- Medications with formulation, drug name, dose, frequency, duration
- Investigations ordered or planned
- Referrals or consultations advised
- Patient/family education provided
- Follow-up instructions and timelines`,
    category: 'SUMMARY',
    variables: declareTypedVariables({
      conversation_language: { type: 'string', required: true },
      pre_summary_text: { type: 'string', required: false },
      prior_visit_summary: { type: 'string', required: false },
    }),
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['department', 'catchall', 'soap', 'text-v1'],
  },
  // ──────────────────────────────────────────────────────────────────
  // ID 41: Whisper Initial Prompt - Bilingual EN-VI Medical Vocabulary
  // ──────────────────────────────────────────────────────────────────
  {
    id: TEMPLATE_IDS.WHISPER_INITIAL_PROMPT_EN_VI,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Whisper Initial Prompt - EN/VI - Template',
    description: 'Bilingual English-Vietnamese',
    content:
      'Okay, để tôi check lại cái report này. ' +
      'Vâng, cái feature đó đã được deploy rồi. ' +
      'Uhm, bây giờ mình confirm lại schedule nhé. ' +
      'Dạ, em update xong rồi.',
    category: 'SYSTEM',
    variables: {},
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['whisper', 'stt', 'initial-prompt', 'en-vi', 'bilingual'],
  },
  // ---------------------------------------------------------------------------
  // GENERIC care-setting templates — the platform day-1 documentation formats.
  //
  // These replace the 22 BCMCH/v1-format specialty templates the Global catalog
  // used to carry. Those bodies still exist, unchanged, on the
  // tenant they belong to: 07b-arcaai-clinical-templates.ts. What is authored
  // here is written to the standard clinical-documentation section conventions
  // and names no organisation, house format, or specialty roster, because every
  // newly-provisioned tenant is given a clone of it.
  //
  // ⚠ TENANCY (TASK-890 J7-1). The eight NEW-ENCOUNTER bodies — the ones
  // `GOLDEN_TEMPLATE_SOURCE_BY_CODE` names, one per care setting — are authored
  // on the **SYSTEM tenant** and carry `departmentId: null`. They used to be
  // authored on Global and PROMOTED onto SYSTEM as byte copies under fresh ids
  // by `07a-agent-golden-library.ts`. That left the same name in two tenants,
  // and phase 26 (`26-tenant-reference-set.ts`) skips a source whose
  // `(tenantId, name)` the target already owns — so Global kept 8 UNSTAMPED
  // originals and received only 9 of SYSTEM's 17 templates, breaking the owner's
  // rule that Global has the same as SYSTEM. A template is authored in exactly
  // one tenant; every other tenant, Global included, gets a stamped clone.
  //
  // The FOLLOW-UP / revisit bodies below stay Global-authored: they are fixture
  // content for the Global playground, not part of the platform reference set,
  // and they collide with no SYSTEM name.
  //
  // `departmentId` is `null` on the eight because a SYSTEM row may not point at
  // a CUSTOMER tenant's department row — which is exactly why 07a had to
  // re-anchor them to a golden SYSTEM department when it copied them.
  //
  // All are APPROVED at version 1 so a fresh tenant resolves them for clinical
  // generation on day 1 without an admin approval step.
  // ---------------------------------------------------------------------------
  {
    id: TEMPLATE_IDS.GENERIC_OUTPATIENT_NEW,
    tenantId: SYSTEM_TENANT_ID,
    name: 'Outpatient - New Consultation',
    description: 'Generic first-visit outpatient note in SOAP order',
    content: `You are a clinical documentation assistant. Produce a structured outpatient consultation note from the encounter transcript supplied below.

Write the note under exactly these headings, in this order:

1. **Chief Complaint**
2. **History of Present Illness**
3. **Relevant Past History, Medications and Allergies**
4. **Examination**
5. **Assessment**
6. **Plan**

Rules:
- Record ONLY what the transcript supports. Never infer a diagnosis, a measurement, a medication, a dose, or a result that was not stated.
- If a heading has no supporting content, write "Not documented" under it rather than omitting the heading or inventing filler.
- Preserve the clinician's own clinical terminology; do not upgrade tentative language into definite findings.
- Attribute anything the patient reports as reported ("patient reports..."), and keep it distinct from examination findings.
- State the reason for the visit in the patient's own terms under Chief Complaint.
- Return the note as markdown under the headings above. Do not add a preamble, a closing summary, or any heading not listed.

Transcript:
{{transcript}}`,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: declareDescribedVariables({ transcript: 'Encounter transcript' }),
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    // SYSTEM-owned: a platform row may not name a CUSTOMER tenant's department.
    departmentId: null,
    tags: ['generic', 'platform-default', 'opd'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_OUTPATIENT_REVISIT,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Outpatient - Follow-Up',
    description: 'Generic outpatient follow-up note centred on interval change',
    content: `You are a clinical documentation assistant. Produce a structured outpatient follow-up note from the encounter transcript supplied below.

Write the note under exactly these headings, in this order:

1. **Reason for Review**
2. **Interval History**
3. **Response to Current Treatment**
4. **Examination**
5. **Assessment**
6. **Plan**

Rules:
- Record ONLY what the transcript supports. Never infer a diagnosis, a measurement, a medication, a dose, or a result that was not stated.
- If a heading has no supporting content, write "Not documented" under it rather than omitting the heading or inventing filler.
- Preserve the clinician's own clinical terminology; do not upgrade tentative language into definite findings.
- Attribute anything the patient reports as reported ("patient reports..."), and keep it distinct from examination findings.
- Interval History covers only what changed since the previous visit; do not restate the original history.
- Return the note as markdown under the headings above. Do not add a preamble, a closing summary, or any heading not listed.

Transcript:
{{transcript}}`,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: declareDescribedVariables({ transcript: 'Encounter transcript' }),
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.OPD,
    tags: ['generic', 'platform-default', 'opd'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_INPATIENT_ADMISSION,
    tenantId: SYSTEM_TENANT_ID,
    name: 'Inpatient - Admission Note',
    description: 'Generic admission note for a newly admitted patient',
    content: `You are a clinical documentation assistant. Produce a structured admission note from the encounter transcript supplied below.

Write the note under exactly these headings, in this order:

1. **Reason for Admission**
2. **History of Present Illness**
3. **Past History, Medications and Allergies**
4. **Examination and Vitals on Admission**
5. **Working Diagnosis**
6. **Initial Management Plan**

Rules:
- Record ONLY what the transcript supports. Never infer a diagnosis, a measurement, a medication, a dose, or a result that was not stated.
- If a heading has no supporting content, write "Not documented" under it rather than omitting the heading or inventing filler.
- Preserve the clinician's own clinical terminology; do not upgrade tentative language into definite findings.
- Attribute anything the patient reports as reported ("patient reports..."), and keep it distinct from examination findings.
- Record admission vitals only if they were explicitly stated; never carry forward a prior value.
- Return the note as markdown under the headings above. Do not add a preamble, a closing summary, or any heading not listed.

Transcript:
{{transcript}}`,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: declareDescribedVariables({ transcript: 'Encounter transcript' }),
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    // SYSTEM-owned: a platform row may not name a CUSTOMER tenant's department.
    departmentId: null,
    tags: ['generic', 'platform-default', 'ipd'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_INPATIENT_PROGRESS,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Inpatient - Daily Progress Note',
    description: 'Generic ward-round progress note',
    content: `You are a clinical documentation assistant. Produce a structured daily progress note from the encounter transcript supplied below.

Write the note under exactly these headings, in this order:

1. **Interval History**
2. **Vitals & Observations**
3. **Examination**
4. **Assessment**
5. **Plan for Today**

Rules:
- Record ONLY what the transcript supports. Never infer a diagnosis, a measurement, a medication, a dose, or a result that was not stated.
- If a heading has no supporting content, write "Not documented" under it rather than omitting the heading or inventing filler.
- Preserve the clinician's own clinical terminology; do not upgrade tentative language into definite findings.
- Attribute anything the patient reports as reported ("patient reports..."), and keep it distinct from examination findings.
- Plan for Today lists actions for this calendar day only; carry nothing over implicitly.
- Return the note as markdown under the headings above. Do not add a preamble, a closing summary, or any heading not listed.

Transcript:
{{transcript}}`,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: declareDescribedVariables({ transcript: 'Encounter transcript' }),
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.IPD,
    tags: ['generic', 'platform-default', 'ipd'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_EMERGENCY_ENCOUNTER,
    tenantId: SYSTEM_TENANT_ID,
    name: 'Emergency - Encounter Note',
    description: 'Generic emergency encounter note ending in an explicit disposition',
    content: `You are a clinical documentation assistant. Produce a structured emergency encounter note from the encounter transcript supplied below.

Write the note under exactly these headings, in this order:

1. **Presenting Problem**
2. **Triage Category**
3. **History**
4. **Examination**
5. **Investigations**
6. **Disposition**

Rules:
- Record ONLY what the transcript supports. Never infer a diagnosis, a measurement, a medication, a dose, or a result that was not stated.
- If a heading has no supporting content, write "Not documented" under it rather than omitting the heading or inventing filler.
- Preserve the clinician's own clinical terminology; do not upgrade tentative language into definite findings.
- Attribute anything the patient reports as reported ("patient reports..."), and keep it distinct from examination findings.
- Disposition must state the outcome explicitly (discharged, admitted, transferred, or left without being seen); never leave it implied.
- Return the note as markdown under the headings above. Do not add a preamble, a closing summary, or any heading not listed.

Transcript:
{{transcript}}`,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: declareDescribedVariables({ transcript: 'Encounter transcript' }),
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    // SYSTEM-owned: a platform row may not name a CUSTOMER tenant's department.
    departmentId: null,
    tags: ['generic', 'platform-default', 'er'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_PERIOP_ASSESSMENT,
    tenantId: SYSTEM_TENANT_ID,
    name: 'Perioperative - Pre-Procedure Assessment',
    description: 'Generic pre-procedure assessment and risk note',
    content: `You are a clinical documentation assistant. Produce a structured pre-procedure assessment note from the encounter transcript supplied below.

Write the note under exactly these headings, in this order:

1. **Indication**
2. **Relevant History**
3. **Medications, Allergies and Anaesthetic History**
4. **Examination**
5. **Risk Assessment**
6. **Plan**

Rules:
- Record ONLY what the transcript supports. Never infer a diagnosis, a measurement, a medication, a dose, or a result that was not stated.
- If a heading has no supporting content, write "Not documented" under it rather than omitting the heading or inventing filler.
- Preserve the clinician's own clinical terminology; do not upgrade tentative language into definite findings.
- Attribute anything the patient reports as reported ("patient reports..."), and keep it distinct from examination findings.
- Record a fitness or risk conclusion only if the clinician stated one; do not derive one from the findings yourself.
- Return the note as markdown under the headings above. Do not add a preamble, a closing summary, or any heading not listed.

Transcript:
{{transcript}}`,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: declareDescribedVariables({ transcript: 'Encounter transcript' }),
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    // SYSTEM-owned: a platform row may not name a CUSTOMER tenant's department.
    departmentId: null,
    tags: ['generic', 'platform-default', 'peri'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_PERIOP_REVIEW,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Perioperative - Post-Procedure Review',
    description: 'Generic post-procedure recovery review note',
    content: `You are a clinical documentation assistant. Produce a structured post-procedure review note from the encounter transcript supplied below.

Write the note under exactly these headings, in this order:

1. **Procedure Performed**
2. **Recovery Progress**
3. **Examination and Observations**
4. **Complications**
5. **Plan**

Rules:
- Record ONLY what the transcript supports. Never infer a diagnosis, a measurement, a medication, a dose, or a result that was not stated.
- If a heading has no supporting content, write "Not documented" under it rather than omitting the heading or inventing filler.
- Preserve the clinician's own clinical terminology; do not upgrade tentative language into definite findings.
- Attribute anything the patient reports as reported ("patient reports..."), and keep it distinct from examination findings.
- Under Complications write "None documented" unless a complication was explicitly described.
- Return the note as markdown under the headings above. Do not add a preamble, a closing summary, or any heading not listed.

Transcript:
{{transcript}}`,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: declareDescribedVariables({ transcript: 'Encounter transcript' }),
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.PERI,
    tags: ['generic', 'platform-default', 'peri'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_IMAGING_REPORT,
    tenantId: SYSTEM_TENANT_ID,
    name: 'Imaging - Diagnostic Report',
    description: 'Generic imaging report answering a stated clinical question',
    content: `You are a clinical documentation assistant. Produce a structured diagnostic imaging report from the encounter transcript supplied below.

Write the note under exactly these headings, in this order:

1. **Clinical Indication**
2. **Technique**
3. **Findings**
4. **Impression**

Rules:
- Record ONLY what the transcript supports. Never infer a diagnosis, a measurement, a medication, a dose, or a result that was not stated.
- If a heading has no supporting content, write "Not documented" under it rather than omitting the heading or inventing filler.
- Preserve the clinician's own clinical terminology; do not upgrade tentative language into definite findings.
- Attribute anything the patient reports as reported ("patient reports..."), and keep it distinct from examination findings.
- Impression answers the stated Clinical Indication directly and introduces no finding absent from Findings.
- Return the note as markdown under the headings above. Do not add a preamble, a closing summary, or any heading not listed.

Transcript:
{{transcript}}`,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: declareDescribedVariables({ transcript: 'Encounter transcript' }),
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    // SYSTEM-owned: a platform row may not name a CUSTOMER tenant's department.
    departmentId: null,
    tags: ['generic', 'platform-default', 'rad'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_LAB_REPORT,
    tenantId: SYSTEM_TENANT_ID,
    name: 'Laboratory - Interpretive Report',
    description: 'Generic interpretive laboratory report',
    content: `You are a clinical documentation assistant. Produce a structured interpretive laboratory report from the encounter transcript supplied below.

Write the note under exactly these headings, in this order:

1. **Specimen**
2. **Results**
3. **Reference Ranges**
4. **Interpretation**

Rules:
- Record ONLY what the transcript supports. Never infer a diagnosis, a measurement, a medication, a dose, or a result that was not stated.
- If a heading has no supporting content, write "Not documented" under it rather than omitting the heading or inventing filler.
- Preserve the clinician's own clinical terminology; do not upgrade tentative language into definite findings.
- Attribute anything the patient reports as reported ("patient reports..."), and keep it distinct from examination findings.
- Reproduce every numeric result and unit exactly as stated; never round, convert, or complete a partial value.
- Return the note as markdown under the headings above. Do not add a preamble, a closing summary, or any heading not listed.

Transcript:
{{transcript}}`,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: declareDescribedVariables({ transcript: 'Encounter transcript' }),
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    // SYSTEM-owned: a platform row may not name a CUSTOMER tenant's department.
    departmentId: null,
    tags: ['generic', 'platform-default', 'lab'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_BEHAVIORAL_ASSESSMENT,
    tenantId: SYSTEM_TENANT_ID,
    name: 'Behavioral Health - Initial Assessment',
    description: 'Generic initial behavioral health assessment with explicit risk section',
    content: `You are a clinical documentation assistant. Produce a structured behavioral health assessment note from the encounter transcript supplied below.

Write the note under exactly these headings, in this order:

1. **Presenting Concern**
2. **History**
3. **Mental State Examination**
4. **Risk Assessment**
5. **Formulation**
6. **Plan**

Rules:
- Record ONLY what the transcript supports. Never infer a diagnosis, a measurement, a medication, a dose, or a result that was not stated.
- If a heading has no supporting content, write "Not documented" under it rather than omitting the heading or inventing filler.
- Preserve the clinician's own clinical terminology; do not upgrade tentative language into definite findings.
- Attribute anything the patient reports as reported ("patient reports..."), and keep it distinct from examination findings.
- Risk Assessment must record what was explicitly asked and answered; if risk was not discussed, write "Not assessed this encounter" rather than "No risk".
- Return the note as markdown under the headings above. Do not add a preamble, a closing summary, or any heading not listed.

Transcript:
{{transcript}}`,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: declareDescribedVariables({ transcript: 'Encounter transcript' }),
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    // SYSTEM-owned: a platform row may not name a CUSTOMER tenant's department.
    departmentId: null,
    tags: ['generic', 'platform-default', 'beh'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_BEHAVIORAL_REVIEW,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Behavioral Health - Review',
    description: 'Generic behavioral health follow-up review note',
    content: `You are a clinical documentation assistant. Produce a structured behavioral health review note from the encounter transcript supplied below.

Write the note under exactly these headings, in this order:

1. **Reason for Review**
2. **Interval History**
3. **Mental State Examination**
4. **Risk Review**
5. **Response to Treatment**
6. **Plan**

Rules:
- Record ONLY what the transcript supports. Never infer a diagnosis, a measurement, a medication, a dose, or a result that was not stated.
- If a heading has no supporting content, write "Not documented" under it rather than omitting the heading or inventing filler.
- Preserve the clinician's own clinical terminology; do not upgrade tentative language into definite findings.
- Attribute anything the patient reports as reported ("patient reports..."), and keep it distinct from examination findings.
- Risk Review must record what was explicitly asked and answered; if risk was not discussed, write "Not assessed this encounter" rather than "No risk".
- Return the note as markdown under the headings above. Do not add a preamble, a closing summary, or any heading not listed.

Transcript:
{{transcript}}`,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: declareDescribedVariables({ transcript: 'Encounter transcript' }),
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.BEH,
    tags: ['generic', 'platform-default', 'beh'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_PEDIATRIC_NEW,
    tenantId: SYSTEM_TENANT_ID,
    name: 'Pediatrics - New Consultation',
    description: 'Generic paediatric first-visit note including growth and immunisation review',
    content: `You are a clinical documentation assistant. Produce a structured paediatric consultation note from the encounter transcript supplied below.

Write the note under exactly these headings, in this order:

1. **Chief Complaint**
2. **History of Present Illness**
3. **Growth & Development**
4. **Immunization Status**
5. **Examination**
6. **Assessment**
7. **Plan**

Rules:
- Record ONLY what the transcript supports. Never infer a diagnosis, a measurement, a medication, a dose, or a result that was not stated.
- If a heading has no supporting content, write "Not documented" under it rather than omitting the heading or inventing filler.
- Preserve the clinician's own clinical terminology; do not upgrade tentative language into definite findings.
- Attribute anything the patient reports as reported ("patient reports..."), and keep it distinct from examination findings.
- Attribute history to the caregiver or the child as the transcript indicates, and record growth measurements only where explicitly stated.
- Return the note as markdown under the headings above. Do not add a preamble, a closing summary, or any heading not listed.

Transcript:
{{transcript}}`,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: declareDescribedVariables({ transcript: 'Encounter transcript' }),
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    // SYSTEM-owned: a platform row may not name a CUSTOMER tenant's department.
    departmentId: null,
    tags: ['generic', 'platform-default', 'peds'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_PEDIATRIC_REVISIT,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Pediatrics - Follow-Up',
    description: 'Generic paediatric follow-up note centred on interval change and growth',
    content: `You are a clinical documentation assistant. Produce a structured paediatric follow-up note from the encounter transcript supplied below.

Write the note under exactly these headings, in this order:

1. **Reason for Review**
2. **Interval History**
3. **Growth & Development**
4. **Examination**
5. **Assessment**
6. **Plan**

Rules:
- Record ONLY what the transcript supports. Never infer a diagnosis, a measurement, a medication, a dose, or a result that was not stated.
- If a heading has no supporting content, write "Not documented" under it rather than omitting the heading or inventing filler.
- Preserve the clinician's own clinical terminology; do not upgrade tentative language into definite findings.
- Attribute anything the patient reports as reported ("patient reports..."), and keep it distinct from examination findings.
- Attribute history to the caregiver or the child as the transcript indicates, and record growth measurements only where explicitly stated.
- Return the note as markdown under the headings above. Do not add a preamble, a closing summary, or any heading not listed.

Transcript:
{{transcript}}`,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: declareDescribedVariables({ transcript: 'Encounter transcript' }),
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.PEDS,
    tags: ['generic', 'platform-default', 'peds'],
  },
  // ──────────────────────────────────────────────────────────────────
  // Lane N — the two PLATFORM-DEFAULT instruction bodies
  //
  // Appended at the END on purpose: `DEFAULT_PROMPT_VERSIONS` maps this array by INDEX onto
  // `VERSION_IDS`, so inserting anywhere else would silently re-point every later template's
  // version row at a different id.
  //
  // Both are TENANT-OVERRIDABLE by construction: a node binds a `promptTemplateId`, and a tenant
  // that has an opinion binds its own template instead of this one. Neither is a fallback the
  // runtime reaches for on its own — an unbound node DEGRADES rather than defaulting, which is why
  // these can be a helpful starting point without becoming the platform's answer.
  // ──────────────────────────────────────────────────────────────────
  {
    id: TEMPLATE_IDS.IMPORTANT_FINDINGS_SYSTEM,
    tenantId: SYSTEM_TENANT_ID,
    approvedVersionNumber: 1,
    name: 'Important Findings Extraction (platform default)',
    description:
      'Platform-default instruction for the `agent.important_findings` node. A tenant admin overrides it by binding their own template on the node — this row is what a tenant with no opinion inherits.',
    // Note what this body does NOT do: it names no severity levels, no red-flag terms and no
    // clinical categories. It tells the model to use the reader's OWN judgement of relevance and
    // to label in its own words, because the labels are the tenant's to define — a shipped
    // vocabulary here would become the platform's answer to a question the owner assigned to the
    // tenant admin, whatever the node config said.
    content:
      'You review a clinical consultation and pick out the information a treating clinician would want brought to their attention immediately.\n\n' +
      'You are given a JSON object with a `transcript` (what was said), and optionally `context` (consultation context items such as case notes) and `entities` (spans a detector already recognised, as hints).\n\n' +
      'Return ONLY a JSON object of this shape:\n' +
      '{"findings":[{"text":"<the exact wording from the source>","type":"<a short label describing why it matters>","confidence":<0.0-1.0>,"rationale":"<one short sentence>"}]}\n\n' +
      'Rules:\n' +
      '- `text` MUST be copied verbatim from the transcript or the supplied context. Never paraphrase it and never write something that is not there.\n' +
      '- If nothing in this material warrants attention, return {"findings":[]}. An empty list is a correct answer.\n' +
      '- Choose `type` yourself, in a few lowercase words. Do not invent a grading scale and do not rank findings against each other.\n' +
      '- Do not diagnose, do not recommend treatment, and do not write a code of any kind.\n' +
      '- Return the JSON object and nothing else.',
    category: 'SYSTEM',
    variables: {},
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['important-findings', 'system', 'platform-default'],
  },
  {
    id: TEMPLATE_IDS.GROUNDING_POLICY_SYSTEM,
    tenantId: SYSTEM_TENANT_ID,
    approvedVersionNumber: 1,
    name: 'Grounding Policy (platform default)',
    description:
      "Platform-default policy body for a `guard.groundedness` node's `policies[]`. A tenant admin declares its own policies by binding its own templates; this row is the starting point.",
    // No pass mark, no score formula and no rubric dimensions. The owner's sentence assigns all
    // three to the tenant admin, so this body asks the model to REPORT what it observed and leaves
    // what to do about it to the tenant's own policy body.
    content:
      'You check one piece of clinical material against the requirements below and report what you find.\n\n' +
      'You are given a JSON object with `appliesTo` (which material this is: `transcript`, `summary` or `findings`) and `subject` (the material itself).\n\n' +
      'Return ONLY a JSON object of this shape:\n' +
      '{"observations":[{"quote":"<the exact wording you are commenting on>","issue":"<what you observed>"}],"supported":<true|false>,"notes":"<one short sentence>"}\n\n' +
      'What to check:\n' +
      '- For a `summary`: every statement should be traceable to what was actually said. Report spelling, grammar, and medical-term or concept errors, and any statement you cannot trace.\n' +
      '- For a `transcript`: report spelling and transcription errors, especially in medication names, doses and clinical terms.\n' +
      '- For `findings`: report any finding whose wording does not appear in the material it was drawn from.\n\n' +
      'Rules:\n' +
      '- `quote` MUST be copied verbatim from `subject`.\n' +
      '- Report only what you can point at. If you observe nothing, return an empty `observations` list with `supported: true`.\n' +
      '- Do not rewrite the material, do not score it out of ten, and do not decide whether it is acceptable — report, and let the reader decide.\n' +
      '- Return the JSON object and nothing else.',
    category: 'SYSTEM',
    variables: {},
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['grounding-policy', 'system', 'platform-default'],
  },
  {
    id: TEMPLATE_IDS.LIVE_GRAMMAR_SYSTEM,
    tenantId: SYSTEM_TENANT_ID,
    approvedVersionNumber: 1,
    name: 'Live Transcript Corrections (platform default)',
    description:
      'Platform-default instruction for the `agent.grammar` node — the LIVE grammar/spelling pass over the raw partial transcript. A tenant admin overrides it by binding their own template on the node.',
    // Two things this body is careful about, both patient-safety rather than style.
    //
    // The three CATEGORIES are named because they are a closed WIRE VOCABULARY, not a clinical
    // taxonomy: `verifyCorrectionProposals` (and its Python twin `_verified_proposals`) drops any
    // proposal whose category it does not recognise, so an instruction that omitted them would
    // produce proposals the verifier silently discards. Naming a protocol is not the platform
    // deciding a clinical question on a tenant's behalf.
    //
    // And it must never be told it may APPLY anything. This pass proposes; the clinician accepts,
    // through the accepted-proposal path. A system that silently rewrites a drug name or a dose in
    // clinical text is a patient-safety defect, which is why `applied: false` rides on every
    // output and why the body says so too.
    content:
      'You review a RAW consultation transcript for spelling, medical-term and drug-name errors. You propose corrections; you never apply them.\n\n' +
      'You are given a JSON object with `text` (the transcript so far) and `entities` (character spans a detector already recognised, as hints about where clinical terms are).\n\n' +
      'Return ONLY a JSON object of this shape:\n' +
      '{"proposals":[{"start":<int>,"end":<int>,"original":"<the exact text at [start,end)>","proposed":"<your replacement>","category":"spelling|medicalTerm|drugName","confidence":<0.0-1.0>,"rationale":"<one short sentence>"}]}\n\n' +
      'Rules:\n' +
      '- `original` MUST be exactly the characters of `text` between `start` and `end`. A proposal whose span does not match its own `original` is discarded.\n' +
      '- Never change a dose, a number, a unit, a date or a name. Correct how a term is SPELLED, never what it says.\n' +
      '- Propose only for spans that are genuinely wrong. Do not restyle ordinary prose, do not punctuate, and do not summarise.\n' +
      '- The transcript is partial and grows between turns. Do not correct a word that is merely cut off at the end.\n' +
      '- If nothing is wrong, return {"proposals":[]}. An empty list is a correct answer.\n' +
      '- Return the JSON object and nothing else.',
    category: 'SYSTEM',
    variables: {},
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['live-grammar', 'system', 'platform-default'],
  },
  {
    id: TEMPLATE_IDS.NOTE_CORRECTIONS_SYSTEM,
    tenantId: SYSTEM_TENANT_ID,
    approvedVersionNumber: 1,
    name: 'Clinical Note Corrections (platform default)',
    description:
      'Platform-default instruction for the `consultation.proposeCorrections` node — the DURABLE pass over a written clinical note. A tenant admin overrides it by binding their own template on the node.',
    // Same two cares as the grammar body, and one more that is specific to reviewing a NOTE.
    //
    // The three CATEGORIES are a closed WIRE VOCABULARY (`_verified_proposals` drops any proposal
    // whose category it does not recognise), not a clinical taxonomy — naming a protocol is not
    // the platform deciding a clinical question on a tenant's behalf.
    //
    // It must never be told it may APPLY anything: this pass proposes, the clinician accepts.
    //
    // And it must not be told the text is still growing. That instruction belongs to the LIVE
    // pass over a partial transcript; here the input is a finished note, so a "wait, it may be
    // cut off" caveat would suppress a correction at the end of the note that is genuinely wrong.
    content:
      'You review a WRITTEN clinical note for spelling, medical-term and drug-name errors. You propose corrections; you never apply them.\n\n' +
      'You are given a JSON object with `text` (the complete note) and `entities` (character spans a detector already recognised, as hints about where clinical terms are).\n\n' +
      'Return ONLY a JSON object of this shape:\n' +
      '{"proposals":[{"start":<int>,"end":<int>,"original":"<the exact text at [start,end)>","proposed":"<your replacement>","category":"spelling|medicalTerm|drugName","confidence":<0.0-1.0>,"rationale":"<one short sentence>"}]}\n\n' +
      'Rules:\n' +
      '- `original` MUST be exactly the characters of `text` between `start` and `end`. A proposal whose span does not match its own `original` is discarded.\n' +
      '- Never change a dose, a number, a unit, a date or a name. Correct how a term is SPELLED, never what it says.\n' +
      '- Propose only for spans that are genuinely wrong. Do not restyle the note, do not re-order or re-word its sections, and do not summarise.\n' +
      '- Do not add clinical content, and do not remove any. A correction replaces a misspelling with the same term spelled correctly, and nothing more.\n' +
      '- If nothing is wrong, return {"proposals":[]}. An empty list is a correct answer.\n' +
      '- Return the JSON object and nothing else.',
    category: 'SYSTEM',
    variables: {},
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['note-corrections', 'system', 'platform-default'],
  },
  // ⚠ APPEND-ONLY TAIL. `DEFAULT_PROMPT_VERSIONS` below derives each version id from this array's
  // INDEX (`V${i + 1}`). A row inserted above this point renumbers every version row after it,
  // re-pointing seeded content at ids that already exist in deployed databases. New platform
  // defaults go HERE, at the end. This one is index 44 → V45 (`72000000-…-045`).
  {
    id: TEMPLATE_IDS.LIVE_SUGGESTIONS_SYSTEM,
    tenantId: SYSTEM_TENANT_ID,
    approvedVersionNumber: 1,
    name: 'Live Consultation Suggestions (platform default)',
    description:
      'Platform-default instruction for the `consultation.suggestions` node — clinician-facing prompts during a LIVE consultation. A tenant admin overrides it by binding their own template on the node.',
    // What this body has to get right, and it is not the same list as its two neighbours.
    //
    // This node PROPOSES rather than CORRECTS, so it is the only one of the three permitted to
    // raise something absent from the text — that is the entire point of an "omission". The
    // safety bar therefore cannot be "add nothing"; it has to be the narrower and harder
    // "ground every item in the supplied text, and never assert".
    //
    // The two failure modes it is written against:
    //  - a suggestion stated as a FINDING ("the patient has X") — the clinician is reading these
    //    mid-consultation and a confident false positive is the expensive kind of wrong;
    //  - an INVENTED detail dressed as something already established, which is worse than a bad
    //    suggestion because it is not obviously one.
    //
    // The empty list is named as a correct answer for the same reason it is in …043/…044: a model
    // told only to produce suggestions will produce them from nothing on a quiet transcript.
    content:
      'You assist a clinician during a LIVE consultation. From the transcript and context you are given, propose the most useful next questions, checks, or omissions for the clinician to consider.\n\n' +
      'Return ONLY a JSON object of this shape:\n' +
      '{"suggestions":[{"text":"<one short, actionable suggestion>","category":"<a short label, e.g. history, examination, investigation, safety>"}]}\n\n' +
      'Rules:\n' +
      '- Ground every suggestion in the supplied text. Do not introduce a condition, medication, allergy, result or history that the text does not support.\n' +
      '- Propose; never assert. Write "consider asking about X" or "check X", never "the patient has X". A suggestion is a prompt for the clinician, not a finding.\n' +
      '- Never state or imply a diagnosis as established fact, and never invent a clinical finding, measurement or result.\n' +
      '- Do not repeat something the transcript shows has already been asked, examined or ordered.\n' +
      '- Keep each suggestion to one specific, actionable step. Do not restate the transcript and do not summarise it.\n' +
      '- The clinician decides. Nothing here is an instruction to the patient or an action taken on their behalf.\n' +
      '- If nothing useful can be suggested, return {"suggestions":[]}. An empty list is a correct answer.\n' +
      '- Return the JSON object and nothing else.',
    category: 'SYSTEM',
    variables: {},
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['live-suggestions', 'system', 'platform-default'],
  },
];

export const DEFAULT_PROMPT_VERSIONS = DEFAULT_PROMPT_TEMPLATES.map((t, i) => ({
  id: VERSION_IDS[`V${String(i + 1).padStart(2, '0')}` as keyof typeof VERSION_IDS],
  // Follows the TEMPLATE's owner rather than hardcoding the Global tenant: a
  // version row must never end up in a different tenant from its template, and
  // PRE_SUMMARY_DEFAULT (…040 / V40) is SYSTEM-owned since.
  tenantId: t.tenantId,
  promptTemplateId: t.id,
  versionNumber: 1,
  content: t.content,
  variables: t.variables,
  changeReason: 'Initial version',
  changedBy: SYSTEM_USER_ID,
}));

// =============================================================================
// CUSTOMER-TENANT PROMPT TEMPLATES — RETIRED (TASK-930 §8.1)
//
// The four ArcaAI demo templates that lived here (`ArcaAI System Prompt`, `ArcaAI SOAP
// Summary`, `ArcaAI Writing Style Analysis`, `ArcaAI Cardiology Note`) were orphans: nothing
// bound them, the ArcaAI clinical library (`07b`) and the SYSTEM reference set are what the
// tenant actually resolves. The two exports stay, EMPTY, because sibling suites iterate them as
// "every seeded template" lists; the seeder below writes nothing for them.
// =============================================================================

export const CUSTOMER_PROMPT_TEMPLATES: ReadonlyArray<(typeof DEFAULT_PROMPT_TEMPLATES)[number]> = [];

export const CUSTOMER_PROMPT_VERSIONS: ReadonlyArray<(typeof DEFAULT_PROMPT_VERSIONS)[number]> = [];

/**
 * Extra historical `PromptVersion` rows layered on top of `DEFAULT_PROMPT_VERSIONS`
 * (versionNumber 2/3 snapshots for SOAP_SUMMARY and DNA_ANALYSIS). Hoisted to
 * module scope (was previously a local inside `seedPromptTemplate`) so the
 * ICD-10 prompt-containment golden test can assert on its content directly.
 */
export const EXTRA_PROMPT_VERSIONS = [
  {
    id: '72000000-0000-0000-0000-000000000101',
    tenantId: DEFAULT_TENANT_ID,
    promptTemplateId: TEMPLATE_IDS.SOAP_SUMMARY,
    versionNumber: 2,
    content:
      'Generate a SOAP-format clinical summary with enhanced structure. Include Subjective (patient history, chief complaint, HPI), Objective (vitals, physical exam, labs), Assessment (primary diagnosis, differentials, severity), and Plan (medications, referrals, follow-up timeline). Use concise clinical language. Flag critical values.',
    variables: declareTypedVariables({
      patient_name: { type: 'string', required: true },
      chief_complaint: { type: 'string', required: true },
      department: { type: 'string', required: false },
      severity: { type: 'string', required: false },
    }),
    changeReason: 'Added critical value flagging',
    changedBy: SYSTEM_USER_ID,
  },
  {
    // Historical snapshot of what version 3 WAS — deliberately preserved
    // verbatim (including the pre-fix "ICD-10 codes" clause) rather than
    // mutated in place; the ICD-10 fix ships as a NEW versionNumber 4 row
    // below, per (rolling `approvedVersionNumber`/`currentVersionNumber`
    // back to 3 must reproduce exactly what was served at the time, ICD-10
    // clause included — the icd10-prompt-containment golden test's allowlist
    // documents this same exception).
    id: '72000000-0000-0000-0000-000000000102',
    tenantId: DEFAULT_TENANT_ID,
    promptTemplateId: TEMPLATE_IDS.SOAP_SUMMARY,
    versionNumber: 3,
    content:
      'Generate a SOAP-format clinical summary with enhanced structure.\n\nInclude:\n- Subjective: patient history, chief complaint, HPI, review of systems\n- Objective: vitals, physical exam findings, labs, imaging\n- Assessment: primary diagnosis, differentials, severity grading, ICD-10 codes\n- Plan: medications with dosages, referrals, follow-up timeline, patient education\n\nUse concise clinical language. Flag critical values. Include confidence levels for differential diagnoses.',
    variables: declareTypedVariables({
      patient_name: { type: 'string', required: true },
      chief_complaint: { type: 'string', required: true },
      department: { type: 'string', required: false },
      severity: { type: 'string', required: false },
    }),
    // reworded from "Restructured with bullet points, added ICD-10
    // codes and confidence levels" — that phrasing described ICD-10 emission
    // as a positive change, which is misleading once the model is no longer
    // instructed to write codes. The `content` above is left untouched (see
    // comment on `id`); only this history-log description string changes.
    changeReason: 'Restructured with bullet points and confidence levels',
    changedBy: SYSTEM_USER_ID,
  },
  {
    // The ICD-10 prompt-containment fix: supersedes versionNumber
    // 3 above without mutating its historical snapshot. SOAP_SUMMARY's
    // `currentVersionNumber` is bumped to 4 so this is the version served.
    id: '72000000-0000-0000-0000-000000000105',
    tenantId: DEFAULT_TENANT_ID,
    promptTemplateId: TEMPLATE_IDS.SOAP_SUMMARY,
    versionNumber: 4,
    content:
      'Generate a SOAP-format clinical summary with enhanced structure.\n\nInclude:\n- Subjective: patient history, chief complaint, HPI, review of systems\n- Objective: vitals, physical exam findings, labs, imaging\n- Assessment: primary diagnosis, differentials, severity grading — by name; do not write, guess, or transcribe a diagnostic code in this field — codes are attached separately from a verified terminology source\n- Plan: medications with dosages, referrals, follow-up timeline, patient education\n\nUse concise clinical language. Flag critical values. Include confidence levels for differential diagnoses.',
    variables: declareTypedVariables({
      patient_name: { type: 'string', required: true },
      chief_complaint: { type: 'string', required: true },
      department: { type: 'string', required: false },
      severity: { type: 'string', required: false },
    }),
    changeReason:
      'ICD-10 prompt containment: removed the free-text ICD-10 code instruction from the Assessment section — diagnosis codes are attached from a verified terminology source, never free-written by the model',
    changedBy: SYSTEM_USER_ID,
  },
  {
    id: '72000000-0000-0000-0000-000000000103',
    tenantId: DEFAULT_TENANT_ID,
    promptTemplateId: TEMPLATE_IDS.DNA_ANALYSIS,
    versionNumber: 2,
    content:
      "Analyze the physician's writing style from the provided consultation transcripts and summaries.\n\nExtract patterns for:\n1. Sentence structure preferences (active/passive, length, complexity)\n2. Medical terminology usage (formal vs colloquial, abbreviation frequency)\n3. Documentation style (narrative vs structured, level of detail)\n4. Common phrases and transition words\n5. Section ordering preferences\n6. Tone and formality level\n\nOutput a structured DNA profile that can be used to generate future summaries matching this physician's style. Include confidence scores for each extracted pattern.",
    variables: declareTypedVariables({
      physician_id: { type: 'string', required: true },
      sample_count: { type: 'number', required: false },
    }),
    changeReason: 'Added confidence scores and expanded pattern categories',
    changedBy: SYSTEM_USER_ID,
  },
  {
    id: '72000000-0000-0000-0000-000000000104',
    tenantId: DEFAULT_TENANT_ID,
    promptTemplateId: TEMPLATE_IDS.DNA_ANALYSIS,
    versionNumber: 3,
    content: DNA_ANALYSIS_CONTENT_V3,
    variables: declareTypedVariables({
      physician_id: { type: 'string', required: true },
      sample_count: { type: 'number', required: false },
    }),
    changeReason:
      'PHI containment: constrained output to a closed-vocabulary JSON schema (metaData.promptConfig) and added an explicit no-patient-content instruction',
    changedBy: SYSTEM_USER_ID,
  },
];

// =============================================================================
// GENERAL MEDICINE CONSULTATION SUMMARY (TASK-930 §8.3)
//
// The template the `general-medicine-summarization` agent binds. Derived from the ArcaAI
// General Medicine v3 corpus (`07b-arcaai-clinical-content-v3.ts`: SAIL discipline, the
// source-of-truth tiers, gated + annotated ASR name repair, third person / past tense, omit
// empty headings) but written in the PARTIAL / INCREMENTAL register: it runs on every live turn
// over a growing transcript and re-emits the running note, so it never treats the transcript as
// finished and never closes a section. The finalized note is `casenote-finalization`'s job.
//
// Every variable is DECLARED, and the agent binds every one (`25-agents.ts`, F6): the nine
// §8.2 context fields ride in through `{{trigger.context.*}}`, and the two document-template
// heading lists are bound as CONSTANTS from `27-document-template-library.ts` — there is no
// document-template binding kind on `Agent.instruction` (only `{ value }` | `{ path }`), so the
// shape is carried as text and selected in the prompt by `visit_type`.
//
// Global (`DEFAULT_TENANT_ID`) AUTHORS the row; SYSTEM carries the promoted copy with
// `sourceTemplateId` pointing back — the same provenance `PromptManagementService.cloneFromSystem`
// stamps on a clone, so proof #9 cannot tell a seeded promotion from a real one.
// =============================================================================

export const SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID = '71000000-0000-0000-0004-000000000002';
const GENERAL_MEDICINE_SUMMARY_VERSION_IDS = {
  GLOBAL: '72000000-0000-0000-0000-000000000051',
  SYSTEM: '72000000-0000-0000-0004-000000000002',
} as const;

/** Declared in the order the body reads them; the agent binds each by name. */
export const GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES: readonly string[] = [
  'visit_type',
  'current_department',
  'language',
  'safe_age',
  'safe_dob',
  'safe_gender',
  'chief_complaint',
  'formatted_vitals',
  'formatted_previous_visits',
  'new_visit_headings',
  'revisit_headings',
];

export const GENERAL_MEDICINE_SUMMARY_CONTENT =
  'You are an expert medical scribe with postgraduate training in Medicine and extensive EMR documentation experience, following SAIL scoring best practices (logical organization, clinical relevance, clarity, no redundancy).\n\n' +
  'You maintain the RUNNING consultation note for a {{current_department}} {{visit_type}} encounter while the consultation is still in progress. The transcript you receive is PARTIAL and grows on every turn: re-emit the whole note each time, extend a section when the transcript adds to it, revise it when the transcript corrects it, and never treat the conversation as finished — no closing summary, no sign-off, no "end of consultation".\n\n' +
  '=== SOURCE-OF-TRUTH PROTOCOL (binding) ===\n' +
  'T1 TRANSCRIPT of today\'s encounter — the only admissible source for what was reported, examined, found, discussed, decided, advised, prescribed or ordered today.\n' +
  'T2 ENCOUNTER METADATA — age {{safe_age}}, date of birth {{safe_dob}}, gender {{safe_gender}}, presenting complaint "{{chief_complaint}}".\n' +
  'T3 RECENT VITALS — {{formatted_vitals}}\n' +
  'T4 PREVIOUS VISITS (pre-summary of prior case notes, most recent first, each fact stamped with the date it was recorded) — {{formatted_previous_visits}}\n' +
  'Higher tiers win every conflict. A T3/T4 fact may appear ONLY where a heading calls for history, must keep its recorded date, and must never be written as if it were said or found today.\n\n' +
  '=== NOTE SHAPE ===\n' +
  'Use EXACTLY the headings of the document template that matches the visit type, in this order, and no others:\n' +
  '- new-visit: {{new_visit_headings}}\n' +
  '- revisit: {{revisit_headings}}\n' +
  'Omit any heading the transcript has not yet reached — omitting a heading is always correct, inventing content under it never is. Write every section as concise clinical prose or short bullets, third person, past tense.\n\n' +
  '=== RULES ===\n' +
  '1. Include only what the doctor actually said, found, decided or ordered; never add AI-generated recommendations, differentials or plans.\n' +
  '2. State medication names, doses, routes and frequencies exactly as spoken; if a dose changed against T4, show the previous dose in brackets.\n' +
  '3. Document negative history only when it was explicitly stated today.\n' +
  '4. ASR terminology repair: when a drug, test or condition name is clearly mis-transcribed and the intended term is unambiguous from context, write the intended term and annotate it (transcribed as "…"). Never repair numbers, doses, dates, laterality or anatomical site.\n' +
  '5. Write all content values in the conversation language ({{language}}); keep the headings in English.\n' +
  '6. Do not carry over information from any other patient. Treat each request independently.\n' +
  '7. Never include names, identifiers, addresses or contact details in the note body.\n\n' +
  'Output the running note as Markdown: one `##` heading per section present, nothing before the first heading and nothing after the last section.';

const GENERAL_MEDICINE_SUMMARY_VARIABLES = declareTypedVariables(
  Object.fromEntries(GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES.map((name) => [name, { type: 'string' as const, required: name !== 'chief_complaint' }])),
);

const generalMedicineSummaryRow = (tenantId: string, id: string, sourceTemplateId: string | null) => ({
  id,
  tenantId,
  name: 'General Medicine Consultation Summary',
  description:
    'The running (partial, per-turn) General Medicine consultation note, derived from the ArcaAI General Medicine v3 corpus. Bound by the `general-medicine-summarization` agent; the document-template headings for the visit type ride in as variables.',
  content: GENERAL_MEDICINE_SUMMARY_CONTENT,
  category: 'SUMMARY' as PromptTemplateCategory,
  status: 'APPROVED' as PromptTemplateStatus,
  scope: 'TENANT_DEFAULT' as PromptTemplateScope,
  variables: GENERAL_MEDICINE_SUMMARY_VARIABLES as Prisma.InputJsonValue,
  currentVersionNumber: 1,
  approvedVersionNumber: 1,
  departmentId: null as string | null,
  sourceTemplateId,
  templateLocked: false,
  tags: ['slug:general-medicine-consultation-summary', 'specialty:general-medicine', 'register:partial-summary'],
});

/** Global authors; SYSTEM is the promoted copy (`sourceTemplateId` → the Global row). */
export const GENERAL_MEDICINE_SUMMARY_TEMPLATES = [
  generalMedicineSummaryRow(DEFAULT_TENANT_ID, TEMPLATE_IDS.GENERAL_MEDICINE_CONSULTATION_SUMMARY, null),
  generalMedicineSummaryRow(SYSTEM_TENANT_ID, SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID, TEMPLATE_IDS.GENERAL_MEDICINE_CONSULTATION_SUMMARY),
];

export const GENERAL_MEDICINE_SUMMARY_VERSIONS = GENERAL_MEDICINE_SUMMARY_TEMPLATES.map((template) => ({
  id: template.tenantId === SYSTEM_TENANT_ID ? GENERAL_MEDICINE_SUMMARY_VERSION_IDS.SYSTEM : GENERAL_MEDICINE_SUMMARY_VERSION_IDS.GLOBAL,
  tenantId: template.tenantId,
  promptTemplateId: template.id,
  versionNumber: 1,
  content: template.content,
  variables: template.variables,
  changeReason: template.sourceTemplateId ? 'Promoted from the Global playground (TASK-930 §8.3)' : 'Initial version (TASK-930 §8.3)',
  changedBy: SYSTEM_USER_ID,
}));

export const seedPromptTemplate = async (client: CorePrismaClient) => {
  console.log('Seeding prompt templates...');
  for (const template of DEFAULT_PROMPT_TEMPLATES) {
    const { variables, ...rest } = template;
    const data = {
      ...rest,
      category: rest.category as PromptTemplateCategory,
      // Publish clinician-facing templates (keep DNA DRAFT) and PIN the
      // approved version — an APPROVED row with no pin resolves to nothing.
      ...resolvePromptPublication(rest),
      ...(variables != null ? { variables: variables as Prisma.InputJsonValue } : {}),
    };
    await client.promptTemplate.upsert({
      where: { id: template.id },
      update: data,
      create: data,
    });
  }
  console.log(`Seeded ${DEFAULT_PROMPT_TEMPLATES.length} prompt templates`);

  console.log('Seeding prompt versions...');
  for (const version of DEFAULT_PROMPT_VERSIONS) {
    const { variables, ...rest } = version;
    const data = {
      ...rest,
      ...(variables != null ? { variables: variables as Prisma.InputJsonValue } : {}),
    };
    await client.promptVersion.upsert({
      where: { id: version.id },
      update: data,
      create: data,
    });
  }

  for (const version of EXTRA_PROMPT_VERSIONS) {
    const { variables, ...rest } = version;
    const data = {
      ...rest,
      ...(variables != null ? { variables: variables as Prisma.InputJsonValue } : {}),
    };
    await client.promptVersion.upsert({
      where: { id: version.id },
      update: data,
      create: data,
    });
  }

  console.log(`Seeded ${DEFAULT_PROMPT_VERSIONS.length + EXTRA_PROMPT_VERSIONS.length} prompt versions`);

  // TASK-930 §8.3 — the General Medicine consultation summary, Global + SYSTEM. Idempotent
  // upsert-by-id like every row above; `variables` is part of the row on purpose (F6 declares).
  console.log('Seeding the General Medicine consultation summary template (Global + SYSTEM)...');
  for (const template of GENERAL_MEDICINE_SUMMARY_TEMPLATES) {
    await client.promptTemplate.upsert({ where: { id: template.id }, update: template, create: template });
  }
  for (const version of GENERAL_MEDICINE_SUMMARY_VERSIONS) {
    await client.promptVersion.upsert({ where: { id: version.id }, update: version, create: version });
  }
  console.log(`Seeded ${GENERAL_MEDICINE_SUMMARY_TEMPLATES.length} General Medicine summary templates + ${GENERAL_MEDICINE_SUMMARY_VERSIONS.length} versions`);
};
