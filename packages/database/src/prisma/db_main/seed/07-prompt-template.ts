import type { CorePrismaClient } from '../../../client';
import { Prisma } from '../../../generated/core-prisma-client/client';
import type { PromptTemplateCategory, PromptTemplateStatus } from '../../../generated/core-prisma-client/enums';
import { SEED_CUSTOMER_TENANT_IDS, SEED_DEPARTMENT_IDS, SYSTEM_TENANT_ID } from './00-constants';

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
 * Structured DNA writing-style output schema (TASK-700 PHI containment).
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
  required: ['sentenceStructure', 'verbosity', 'listVsNarrative', 'sectionOrderPreference', 'abbreviationFrequency', 'toneFormality', 'confidenceScores'],
};

/** DNA prompt hyperparameters + output schema, persisted under `metaData.promptConfig`. */
export const DNA_PROMPT_CONFIG = {
  hyperparameters: { temperature: 0.0, max_tokens: 8192, top_p: 0.95 },
  outputSchema: DNA_OUTPUT_SCHEMA,
};

/**
 * DNA_ANALYSIS prompt content, v3 (TASK-700). Defense-in-depth over the
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
  // (04-department.ts). Authored for TASK-763 §5 OD-8: the previous Global
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
  // Lane N (TASK-815 §14a/§14b) — the PLATFORM DEFAULT instruction and grounding policy.
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
  WHISPER_INITIAL_PROMPT_EN_VI: '71000000-0000-0000-0000-000000000050',
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

- **Department:** {current_department}

- **Visit Type:** {visit_type}

- **Demographics:** Age {safe_age}, DOB {safe_dob}, Gender {safe_gender}

- **Recent Vitals:** {safe_vitals} (two most recent encounters)

- **Test Results:** {formatted_test_results}

- **Previous Visits:** {formatted_previous_visits}

---

## REQUIREMENTS

### PRIORITIZE:

- Notes from {current_department}

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

- Language: {language_name}

### INSTRUCTIONS

- Use the following section headers EXACTLY as written (in English) and do NOT translate them.
- Write ALL bullet content in {language_name}, including any text inside parentheses.
- Translate ALL English descriptors from context into {language_name}
- Translate ALL text that appears in parentheses into {language_name}
- Parentheses Localization Policy: For any parentheses that contain English words, translate them into {language_name}. If a direct translation is unclear, paraphrase briefly in {language_name}. Only leave English inside parentheses for standard clinical abbreviations (BP, HR, RR, Temp, SpO2) and measurement units (°C, mmHg, mg, ml).
- Do NOT include English words in bullet items or parentheses, except for:
- Standard clinical abbreviations (e.g., BP, HR, RR, Temp, SpO2)
- Measurement units (e.g., °C, mmHg, mg, ml)
- Before finalizing, perform a self-check: scan every pair of parentheses and ensure there are no English words inside (except the allowed abbreviations/units). If any are found, replace them with {language_name} equivalents.
- Translate or localize any status or qualifier terms or any text inside parentheses into {language_name}.

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
    variables: {
      patient_name: { type: 'string', required: true },
      department: { type: 'string', required: false },
    },
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
    variables: {
      patient_name: { type: 'string', required: true },
      chief_complaint: { type: 'string', required: true },
      department: { type: 'string', required: false },
      severity: { type: 'string', required: false },
    },
    // Activate structured SOAP output (json_schema).
    metaData: { promptConfig: SOAP_PROMPT_CONFIG } as Prisma.InputJsonValue,
    // TASK-702: bumped 3 -> 4 — v4 (EXTRA_PROMPT_VERSIONS id …0105) removes the
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
    variables: {
      physician_id: { type: 'string', required: true },
      sample_count: { type: 'number', required: false },
    },
    // Constrain DNA output to the closed-vocabulary schema (TASK-700 PHI
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
    variables: {
      patient_name: { type: 'string', required: true },
      cardiac_history: { type: 'string', required: false },
      ecg_results: { type: 'string', required: false },
    },
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
    description: 'Unified pre-summary template for all departments. Uses {current_department} for department-aware prioritization.',
    content: SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT,
    category: 'SYSTEM',
    variables: {
      current_department: 'Department name injected at runtime',
      visit_type: 'new-visit or revisit',
      safe_age: 'Patient age',
      safe_dob: 'Patient date of birth',
      safe_gender: 'Patient gender',
      safe_vitals: 'Recent vitals data',
      formatted_test_results: 'Formatted test results',
      formatted_previous_visits: 'Formatted previous visit summaries',
      language_name: 'Output language name',
    },
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
    tenantId: DEFAULT_TENANT_ID,
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
    variables: {
      conversation_language: { type: 'string', required: true },
      pre_summary_text: { type: 'string', required: false },
      prior_visit_summary: { type: 'string', required: false },
    },
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
  // used to carry (TASK-763 §5 OD-8). Those bodies still exist, unchanged, on the
  // tenant they belong to: 07b-arcaai-clinical-templates.ts. What is authored
  // here is written to the standard clinical-documentation section conventions
  // and names no organisation, house format, or specialty roster, because
  // 07a-agent-golden-library.ts promotes whatever is here onto the SYSTEM tenant
  // and every newly-provisioned tenant is given a clone of it.
  //
  // All are APPROVED at version 1 so a fresh tenant resolves them for clinical
  // generation on day 1 without an admin approval step.
  // ---------------------------------------------------------------------------
  {
    id: TEMPLATE_IDS.GENERIC_OUTPATIENT_NEW,
    tenantId: DEFAULT_TENANT_ID,
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
    variables: { transcript: 'Encounter transcript' },
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.OPD,
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
    variables: { transcript: 'Encounter transcript' },
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.OPD,
    tags: ['generic', 'platform-default', 'opd'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_INPATIENT_ADMISSION,
    tenantId: DEFAULT_TENANT_ID,
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
    variables: { transcript: 'Encounter transcript' },
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.IPD,
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
    variables: { transcript: 'Encounter transcript' },
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.IPD,
    tags: ['generic', 'platform-default', 'ipd'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_EMERGENCY_ENCOUNTER,
    tenantId: DEFAULT_TENANT_ID,
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
    variables: { transcript: 'Encounter transcript' },
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.ER,
    tags: ['generic', 'platform-default', 'er'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_PERIOP_ASSESSMENT,
    tenantId: DEFAULT_TENANT_ID,
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
    variables: { transcript: 'Encounter transcript' },
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.PERI,
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
    variables: { transcript: 'Encounter transcript' },
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.PERI,
    tags: ['generic', 'platform-default', 'peri'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_IMAGING_REPORT,
    tenantId: DEFAULT_TENANT_ID,
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
    variables: { transcript: 'Encounter transcript' },
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.RAD,
    tags: ['generic', 'platform-default', 'rad'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_LAB_REPORT,
    tenantId: DEFAULT_TENANT_ID,
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
    variables: { transcript: 'Encounter transcript' },
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.LAB,
    tags: ['generic', 'platform-default', 'lab'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_BEHAVIORAL_ASSESSMENT,
    tenantId: DEFAULT_TENANT_ID,
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
    variables: { transcript: 'Encounter transcript' },
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.BEH,
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
    variables: { transcript: 'Encounter transcript' },
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.BEH,
    tags: ['generic', 'platform-default', 'beh'],
  },
  {
    id: TEMPLATE_IDS.GENERIC_PEDIATRIC_NEW,
    tenantId: DEFAULT_TENANT_ID,
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
    variables: { transcript: 'Encounter transcript' },
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.PEDS,
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
    variables: { transcript: 'Encounter transcript' },
    currentVersionNumber: 1,
    approvedVersionNumber: 1,
    departmentId: DEPT.PEDS,
    tags: ['generic', 'platform-default', 'peds'],
  },
  // ──────────────────────────────────────────────────────────────────
  // Lane N — the two PLATFORM-DEFAULT instruction bodies (TASK-815 §14a/§14b)
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
      "Platform-default instruction for the `agent.important_findings` node. A tenant admin overrides it by binding their own template on the node — this row is what a tenant with no opinion inherits.",
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
// CUSTOMER-TENANT PROMPT TEMPLATES
//
// The DEFAULT_PROMPT_TEMPLATES above all belong to the Global customer tenant
// (DEFAULT_TENANT_ID). The ArcaAI customer tenant had
// ZERO prompt templates, so the admin cross-tenant switcher demoed empty for
// it. This block adds a small, realistic, idempotent set
// (4 per tenant covering SYSTEM / SUMMARY / DNA_ANALYSIS / CUSTOM) so the
// switcher shows distinct, believable per-tenant content.
//
// ID convention mirrors the per-tenant 4th-UUID-group encoding used by the
// department / global-setting seeds: 0001 = ArcaAI.
// Templates use the `71…` prefix; their initial versions use
// the matching `72…` prefix (see customerVersionId below). The CUSTOM
// (cardiology) template is attached to that tenant's own CARD department.
// =============================================================================
const CUSTOMER_TEMPLATE_IDS = {
  // ArcaAI (0001)
  ARCAAI_SYSTEM: '71000000-0000-0000-0001-000000000001',
  ARCAAI_SUMMARY: '71000000-0000-0000-0001-000000000002',
  ARCAAI_DNA: '71000000-0000-0000-0001-000000000003',
  ARCAAI_CARD: '71000000-0000-0000-0001-000000000004',
} as const;

// The initial version of each customer template reuses the template UUID with
// the `72…` (PromptVersion) prefix so the cross-reference stays deterministic
// and idempotent without a parallel hand-maintained map.
const customerVersionId = (templateId: string): string => `72${templateId.slice(2)}`;

export const CUSTOMER_PROMPT_TEMPLATES = [
  // --- ArcaAI ------------------------------------------------------------
  {
    id: CUSTOMER_TEMPLATE_IDS.ARCAAI_SYSTEM,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    name: 'ArcaAI System Prompt',
    description: 'ArcaAI house system prompt for ambient clinical documentation',
    content:
      'You are ArcaAI, an ambient clinical documentation assistant. Produce accurate, concise notes from the consultation. Preserve the conversation language, use standard medical terminology, never invent findings, and keep all patient identifiers confidential. Format output according to the active department template.',
    category: 'SYSTEM',
    variables: {
      patient_name: { type: 'string', required: true },
      department: { type: 'string', required: false },
    },
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['arcaai', 'system'],
  },
  {
    id: CUSTOMER_TEMPLATE_IDS.ARCAAI_SUMMARY,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    name: 'ArcaAI SOAP Summary',
    description: 'ArcaAI SOAP-format clinical summary tuned for outpatient encounters',
    content:
      'Generate a SOAP-format clinical summary for an ArcaAI outpatient encounter.\n\n- Subjective: chief complaint, HPI, relevant history\n- Objective: vitals, examination findings, available investigations\n- Assessment: working diagnosis and key differentials\n- Plan: medications, referrals, follow-up timeline, patient education\n\nUse concise clinical language and flag any critical values.',
    category: 'SUMMARY',
    variables: {
      patient_name: { type: 'string', required: true },
      chief_complaint: { type: 'string', required: true },
      department: { type: 'string', required: false },
    },
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['arcaai', 'soap', 'summary'],
  },
  {
    id: CUSTOMER_TEMPLATE_IDS.ARCAAI_DNA,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    name: 'ArcaAI Writing Style Analysis',
    description: 'ArcaAI prompt for analysing a clinician writing style (DNA)',
    content:
      "Analyse the clinician's documentation style from the supplied ArcaAI transcripts and notes. Extract sentence-structure preferences, terminology and abbreviation habits, section ordering, and tone. Output a structured style profile with confidence scores that can steer future summaries to match this clinician.\n\nDo not reproduce, quote, or paraphrase any patient name, identifier, date, medication, dose, or other encounter-specific fact from the source material — describe stylistic patterns only, never patient content.",
    category: 'DNA_ANALYSIS',
    variables: {
      physician_id: { type: 'string', required: true },
      sample_count: { type: 'number', required: false },
    },
    // TASK-700 PHI containment: this is the tenant whose DNA feature is
    // LIVE today (`14-pipeline-policy.ts` ARCAAI_PIPELINE_POLICY_OVERRIDE
    // sets `dnaStyleEnabled: true`), so the schema constraint that closes the
    // free-text output defect must be seeded onto ArcaAI's OWN copy of the
    // template — `listPromptTemplates` resolves strictly by `tenantId`, so
    // the DEFAULT_TENANT_ID fix above does not reach this tenant's
    // generations on its own.
    metaData: { promptConfig: DNA_PROMPT_CONFIG } as Prisma.InputJsonValue,
    currentVersionNumber: 1,
    departmentId: null,
    tags: ['arcaai', 'dna', 'writing-style'],
  },
  {
    id: CUSTOMER_TEMPLATE_IDS.ARCAAI_CARD,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    name: 'ArcaAI Cardiology Note',
    description: 'ArcaAI cardiology-specific documentation prompt',
    content:
      'Generate cardiology documentation for ArcaAI. Capture cardiac history, relevant vitals (BP, HR, rhythm), ECG findings when present, and the cardiovascular examination. Use cardiology-standard terminology (LVEF, NYHA, STEMI) and highlight any time-critical findings.',
    category: 'CUSTOM',
    variables: {
      patient_name: { type: 'string', required: true },
      ecg_results: { type: 'string', required: false },
    },
    currentVersionNumber: 1,
    // departmentId is null: the former ArcaAI CARD department was retired in
    // The ArcaAI tenant now carries the 7 v1 clinica
    // departments). This demo cross-tenant-switcher template stays as a
    // tenant-level CUSTOM cardiology prompt with no department binding.
    departmentId: null,
    tags: ['arcaai', 'cardiology'],
  },
];

export const CUSTOMER_PROMPT_VERSIONS = CUSTOMER_PROMPT_TEMPLATES.map((t) => ({
  id: customerVersionId(t.id),
  tenantId: t.tenantId,
  promptTemplateId: t.id,
  versionNumber: 1,
  content: t.content,
  variables: t.variables,
  changeReason: 'Initial version',
  changedBy: SYSTEM_USER_ID,
}));

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
    variables: {
      patient_name: { type: 'string', required: true },
      chief_complaint: { type: 'string', required: true },
      department: { type: 'string', required: false },
      severity: { type: 'string', required: false },
    },
    changeReason: 'Added critical value flagging',
    changedBy: SYSTEM_USER_ID,
  },
  {
    // Historical snapshot of what version 3 WAS — deliberately preserved
    // verbatim (including the pre-fix "ICD-10 codes" clause) rather than
    // mutated in place; the ICD-10 fix ships as a NEW versionNumber 4 row
    // below, per TASK-702 (rolling `approvedVersionNumber`/`currentVersionNumber`
    // back to 3 must reproduce exactly what was served at the time, ICD-10
    // clause included — the icd10-prompt-containment golden test's allowlist
    // documents this same exception).
    id: '72000000-0000-0000-0000-000000000102',
    tenantId: DEFAULT_TENANT_ID,
    promptTemplateId: TEMPLATE_IDS.SOAP_SUMMARY,
    versionNumber: 3,
    content:
      'Generate a SOAP-format clinical summary with enhanced structure.\n\nInclude:\n- Subjective: patient history, chief complaint, HPI, review of systems\n- Objective: vitals, physical exam findings, labs, imaging\n- Assessment: primary diagnosis, differentials, severity grading, ICD-10 codes\n- Plan: medications with dosages, referrals, follow-up timeline, patient education\n\nUse concise clinical language. Flag critical values. Include confidence levels for differential diagnoses.',
    variables: {
      patient_name: { type: 'string', required: true },
      chief_complaint: { type: 'string', required: true },
      department: { type: 'string', required: false },
      severity: { type: 'string', required: false },
    },
    // TASK-702: reworded from "Restructured with bullet points, added ICD-10
    // codes and confidence levels" — that phrasing described ICD-10 emission
    // as a positive change, which is misleading once the model is no longer
    // instructed to write codes. The `content` above is left untouched (see
    // comment on `id`); only this history-log description string changes.
    changeReason: 'Restructured with bullet points and confidence levels',
    changedBy: SYSTEM_USER_ID,
  },
  {
    // The ICD-10 prompt-containment fix (TASK-702): supersedes versionNumber
    // 3 above without mutating its historical snapshot. SOAP_SUMMARY's
    // `currentVersionNumber` is bumped to 4 so this is the version served.
    id: '72000000-0000-0000-0000-000000000105',
    tenantId: DEFAULT_TENANT_ID,
    promptTemplateId: TEMPLATE_IDS.SOAP_SUMMARY,
    versionNumber: 4,
    content:
      'Generate a SOAP-format clinical summary with enhanced structure.\n\nInclude:\n- Subjective: patient history, chief complaint, HPI, review of systems\n- Objective: vitals, physical exam findings, labs, imaging\n- Assessment: primary diagnosis, differentials, severity grading — by name; do not write, guess, or transcribe a diagnostic code in this field — codes are attached separately from a verified terminology source\n- Plan: medications with dosages, referrals, follow-up timeline, patient education\n\nUse concise clinical language. Flag critical values. Include confidence levels for differential diagnoses.',
    variables: {
      patient_name: { type: 'string', required: true },
      chief_complaint: { type: 'string', required: true },
      department: { type: 'string', required: false },
      severity: { type: 'string', required: false },
    },
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
    variables: {
      physician_id: { type: 'string', required: true },
      sample_count: { type: 'number', required: false },
    },
    changeReason: 'Added confidence scores and expanded pattern categories',
    changedBy: SYSTEM_USER_ID,
  },
  {
    id: '72000000-0000-0000-0000-000000000104',
    tenantId: DEFAULT_TENANT_ID,
    promptTemplateId: TEMPLATE_IDS.DNA_ANALYSIS,
    versionNumber: 3,
    content: DNA_ANALYSIS_CONTENT_V3,
    variables: {
      physician_id: { type: 'string', required: true },
      sample_count: { type: 'number', required: false },
    },
    changeReason: 'PHI containment: constrained output to a closed-vocabulary JSON schema (metaData.promptConfig) and added an explicit no-patient-content instruction',
    changedBy: SYSTEM_USER_ID,
  },
];

export const seedPromptTemplate = async (client: CorePrismaClient) => {
  console.log('Seeding prompt templates...');
  for (const template of DEFAULT_PROMPT_TEMPLATES) {
    const { variables, ...rest } = template;
    const data = {
      ...rest,
      category: rest.category as PromptTemplateCategory,
      // Publish clinician-facing templates (keep DNA DRAFT).
      status: resolvePromptStatus(rest.category),
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

  // Customer-tenant templates + initial versions.
  console.log('Seeding customer-tenant prompt templates...');
  for (const template of CUSTOMER_PROMPT_TEMPLATES) {
    const { variables, ...rest } = template;
    const data = {
      ...rest,
      category: rest.category as PromptTemplateCategory,
      // Publish clinician-facing templates (keep DNA DRAFT)
      // so every customer tenant has >= 1 PUBLISHED template to resolve.
      status: resolvePromptStatus(rest.category),
      ...(variables != null ? { variables: variables as Prisma.InputJsonValue } : {}),
    };
    await client.promptTemplate.upsert({
      where: { id: template.id },
      update: data,
      create: data,
    });
  }
  console.log(`Seeded ${CUSTOMER_PROMPT_TEMPLATES.length} customer-tenant prompt templates`);

  console.log('Seeding customer-tenant prompt versions...');
  for (const version of CUSTOMER_PROMPT_VERSIONS) {
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
  console.log(`Seeded ${CUSTOMER_PROMPT_VERSIONS.length} customer-tenant prompt versions`);
};
