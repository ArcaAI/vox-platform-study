import { buildPreSummaryVariables, substitutePreSummaryVariables } from '@arcaai/applications';
import { humanizeField, selectDeptTemplate } from './dept-templates';
import type { PreSummaryRequest } from './dto/pre-summary.request';
import type { PreviousVisitRecordDto, SessionDataDto, TestResultDto } from './dto/session-data.dto';

/**
 * v1's language map and its nine pre-summary variables now live in
 * `@arcaai/applications` (`services/consultation/prompt/pre-summary-variables.ts`)
 * so the NATIVE Vox SDK v2 path (`PromptAssemblyService`) interpolates the very
 * same bodies with the very same defaults (OD-2/OD-3)
 * `apps/api` depends on that package, so a copy here would be the one that
 * drifts. Re-exported unchanged for this module's existing consumers/tests.
 */
export { PRE_SUMMARY_TEMPLATE_VARIABLES, resolveV1LanguageName } from '@arcaai/applications';

/** Assembled `{ system, user }` prompt pair sent to SMR `/generate`. */
export interface AssembledPrompt {
  system: string;
  user: string;
}

export interface SummaryPromptOptions {
  department?: string;
  visitType?: string;
  specialty?: string;
  encounterType?: string;
  /**
   * The consultation's SOURCE language ("en" / "ml" / "ml-en" …). It selects
   * whether the transcript is translated before summarization — it does NOT
   * choose the output language. The note is always English; see
   * `languageDirective` below.
   */
  language?: string;
  /**
   * Whether pre-summary enrichment is enabled. Decided by the controller per
   * the documented enrichment logic (SMR_Summary_Endpoints.md §3.1); the
   * builder folds `session_data.pre_summary_text` in ONLY when this is true.
   */
  includePreSummary?: boolean;
  /**
   * The tenant department's governed instruction template content (an APPROVED,
   * version-pinned `PromptVersion` snapshot resolved via `PromptResolutionService`,
   * ). When present it becomes the authoritative clinical steering and
   * REPLACES the static dept×visit field-set guidance; the v1 wire-schema
   * directive is still appended so the response shape stays Simplified/Enhanced.
   */
  governedInstruction?: string;
  /**
   * The requesting doctor's DNA writing-style text, already decrypted
   * and gate-checked by the controller. When present it is appended as style
   * guidance (tone/formatting/phrasing) — it never alters clinical facts and does
   * NOT change the wire schema. Absent ⇒ no style directive (D5: no doctorId ⇒
   * department + visit-type only).
   */
  dnaStyleText?: string;
}

/**
 * The clinical note is ALWAYS written in English (owner decision
 * 2026-08-10 option (a)). `language` describes the SOURCE of the consultation —
 * it drives whether the transcript is translated (Sarvam) — and is never an
 * instruction about the OUTPUT.
 *
 * Two things forced this to be unconditional rather than "default English,
 * honour an explicit request":
 *
 *  1. The department template injected below as AUTHORITATIVE steering carries,
 *     in 13 seeded rows, its own `content in conversation language, headings in
 *     English` clause. A generic label loses to that specific in-template
 *     instruction, so the directive must NAME the conflict it overrides.
 *  2. `language` is not a request for an output language at all. Real callers
 *     send the STT locale — `ml-en`, a CODE-SWITCH marker meaning "Malayalam and
 *     English mixed". `resolveV1LanguageName` reduces it to the base subtag
 *     (`ml`) and it was read as "write Malayalam". Verified live 2026-08-10:
 *     that payload produced a fully Malayalam clinical note.
 *
 * So the output language is not derived from caller input. This supersedes
 * ON THE COMPAT SUMMARY SURFACE ONLY — D-11 fixed an `ml` request
 * being told to answer in English, which was correct while output language
 * tracked the source. Under R1 the note is an English artefact regardless, and
 * localisation is the translate step's job, not the note's.
 */
const SUMMARY_OUTPUT_LANGUAGE = 'English';

function languageDirective(): string {
  return `Write ALL summary content in ${SUMMARY_OUTPUT_LANGUAGE}, regardless of the transcript's language and regardless of any conflicting language instruction in the department instruction above (for example, an instruction to write content in the conversation language). Translate any non-${SUMMARY_OUTPUT_LANGUAGE} clinical content into ${SUMMARY_OUTPUT_LANGUAGE}. Section headings stay in ${SUMMARY_OUTPUT_LANGUAGE}.`;
}

/** One rendered transcript line per turn — fixes v1 F2 (whole transcript collapsed into one segment). */
/** Does any turn carry an original alongside a machine translation of it? */
function hasBilingualTurns(segments: SessionDataDto['conversation_segments']): boolean {
  return (segments ?? []).some((seg) => {
    const original = seg.original_text?.trim();
    return Boolean(original) && original !== (seg.text?.trim() ?? '');
  });
}

/**
 * One rendered transcript line per turn — plus, when the turn was machine
 * translated, a second line carrying the clinician's original words.
 *
 * The original line is suppressed when it is identical to the translation
 * (an already-English turn round-tripped through the translator), so an
 * English consultation renders exactly as it did before.
 */
function renderSegments(segments: SessionDataDto['conversation_segments']): string {
  if (!segments || segments.length === 0) {
    return '(no conversation transcript provided)';
  }
  return segments
    .map((seg) => {
      const speaker = seg.speaker?.trim() || 'unknown';
      const text = seg.text?.trim() ?? '';
      const original = seg.original_text?.trim();
      if (original && original !== text) {
        return `${speaker}: ${text}\n${speaker} (original, untranslated): ${original}`;
      }
      return `${speaker}: ${text}`;
    })
    .join('\n');
}

/**
 * Steering for a bilingual transcript.
 *
 * Sarvam is a general-purpose MT engine with no clinical vocabulary, and the
 * summary is built from its output. Verified live on `hope-v2-dev` 2026-08-10
 * against one real `ml-en` consultation, the translation alone produced:
 *   - `aceclofenac 100 mg PRN` → "Acetaminophen 100 mg" — a DIFFERENT DRUG;
 *   - `marked ... subchondral sclerosis` → "mild" — an inverted severity;
 *   - `medial joint space narrowing` and the referred physiotherapist's name
 *     dropped entirely.
 * The same payload summarized WITHOUT pre-translation got all of them right,
 * because the model reads the code-switched original far better than the MT
 * engine renders it.
 *
 * So the translation stays — it is what makes the note readable English — but
 * it stops being the sole source. The directive names the specific classes
 * that were observed to break rather than a generic "be accurate", because a
 * generic instruction gives the model no reason to prefer one line over the
 * other when they disagree.
 */
const BILINGUAL_TRANSCRIPT_DIRECTIVE =
  'Each transcript turn may appear twice: a machine translation, followed by a line marked "(original, untranslated)" carrying the speaker\'s own words. ' +
  'The machine translation is not clinically reliable — it has been observed to substitute one drug for another, invert severity qualifiers, and drop findings and proper nouns. ' +
  'Use the translation only to follow the conversation. For every clinical fact — drug names, doses, routes, frequencies, numbers, measurements, scores, severity qualifiers, anatomical sites, and proper nouns — take the value from the original line whenever the two disagree, and render it in English yourself.';

function renderTestResults(results?: TestResultDto[]): string | null {
  if (!results || results.length === 0) return null;
  return results
    .map((r) => {
      const parts = [`${r.test_name} (${r.test_type}): ${r.result}`];
      if (r.reference_range) parts.push(`ref ${r.reference_range}`);
      if (r.status) parts.push(r.status);
      if (r.date) parts.push(r.date);
      return `- ${parts.join(' · ')}`;
    })
    .join('\n');
}

function renderPreviousVisits(visits?: PreviousVisitRecordDto[]): string | null {
  if (!visits || visits.length === 0) return null;
  return visits
    .map((v) => {
      const parts = [`${v.visit_date} ${v.visit_type}: ${v.chief_complaint}`];
      if (v.diagnosis) parts.push(`dx: ${v.diagnosis}`);
      if (v.treatment) parts.push(`tx: ${v.treatment}`);
      if (v.follow_up_plan) parts.push(`f/u: ${v.follow_up_plan}`);
      return `- ${parts.join(' · ')}`;
    })
    .join('\n');
}

function renderPatientInfo(info?: Record<string, unknown>): string | null {
  if (!info || Object.keys(info).length === 0) return null;
  return Object.entries(info)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ');
}

/**
 * Build the summarization `{ system, user }` prompt from a v1 `SessionData`.
 *
 * The system prompt is department/visit-type aware and instructs the model to
 * emit JSON matching the requested schema (Enhanced vs Simplified is enforced
 * at the wire level via `response_format.json_schema`). The user prompt renders
 * the transcript PER TURN and folds in structured/plain-text context, plus the
 * department-aware pre-summary when enrichment is enabled.
 */
export function buildSummaryPrompt(sessionData: SessionDataDto, options: SummaryPromptOptions = {}): AssembledPrompt {
  const department = options.department?.trim() || 'General Medicine';
  const visitType = options.visitType?.trim();
  const specialty = options.specialty?.trim();
  const encounterType = options.encounterType?.trim();

  const systemLines = [
    'You are a clinical documentation assistant.',
    `Produce a structured medical summary for a ${department} encounter${visitType ? ` (${visitType})` : ''}.`,
  ];
  if (specialty) systemLines.push(`Specialty context: ${specialty}.`);
  if (encounterType) systemLines.push(`Encounter type: ${encounterType}.`);

  // When the tenant's real Department resolves to a governed,
  // APPROVED instruction template, that content is the authoritative clinical
  // steering — it supersedes the static v1 dept×visit field set. The wire
  // response still stays Simplified/Enhanced (enforced at `response_format`), so
  // we append the schema directive below just as in the static path.
  const governed = options.governedInstruction?.trim();
  if (governed) {
    systemLines.push(
      `Follow this department's clinical documentation instruction where the transcript or context supports it, and map the resulting content into the generic summary fields defined by the schema (do not add fields outside the schema):\n${governed}`,
    );
  } else {
    // v1 department×visit steering — the fallback when no real
    // tenant department/governed template resolved. For the 6 non-medicine
    // departments the v1 `DEPT_VISIT_SCHEMAS` field set becomes prompt guidance
    // ("capture these department-relevant areas"); General/Medicine and unknown
    // departments keep the generic path (null here).
    const deptTemplate = selectDeptTemplate(options.department, options.visitType);
    if (deptTemplate) {
      const sections = deptTemplate.fields.map(humanizeField).join(', ');
      systemLines.push(
        `Department-specific documentation focus for this ${department} encounter: where documented in the transcript or context, ensure the summary captures ${sections}. Map that clinical content into the generic summary fields defined by the schema; do not add fields outside the schema.`,
      );
    }
  }

  // The requesting doctor's DNA writing-style, applied to tone
  // formatting / phrasing only — never the clinical facts, and never the wire
  // schema. Appended as guidance; absent when no doctorId resolved (D5).
  const dnaStyle = options.dnaStyleText?.trim();
  if (dnaStyle) {
    systemLines.push(
      `Match this clinician's documentation writing style (tone, formatting, and section phrasing) without changing any clinical facts:\n${dnaStyle}`,
    );
  }

  systemLines.push(
    'Base the summary strictly on the provided transcript and context; do not fabricate findings.',
    'Respond with a single JSON object that conforms to the provided schema. Output JSON only — no prose, no markdown fences.',
  );

  // Placed AFTER the department/DNA steering and BEFORE the language directive:
  // it must outrank any governed template's own wording about the transcript,
  // and it is what the language directive's "translate any non-English content"
  // then acts on.
  if (hasBilingualTurns(sessionData.conversation_segments)) {
    systemLines.push(BILINGUAL_TRANSCRIPT_DIRECTIVE);
  }

  systemLines.push(languageDirective());

  const userSections: string[] = [];

  const patientInfo = renderPatientInfo(sessionData.patient_info);
  if (patientInfo) userSections.push(`Patient information:\n${patientInfo}`);

  if (options.includePreSummary && sessionData.pre_summary_text?.trim()) {
    userSections.push(`Pre-summary of prior history:\n${sessionData.pre_summary_text.trim()}`);
  }

  userSections.push(`Consultation transcript:\n${renderSegments(sessionData.conversation_segments)}`);

  const structuredTests = renderTestResults(sessionData.test_results);
  if (structuredTests) userSections.push(`Test results:\n${structuredTests}`);
  else if (sessionData.test_results_text?.trim()) userSections.push(`Test results:\n${sessionData.test_results_text.trim()}`);

  const structuredVisits = renderPreviousVisits(sessionData.previous_visits);
  if (structuredVisits) userSections.push(`Previous visits:\n${structuredVisits}`);
  else if (sessionData.previous_visits_text?.trim()) userSections.push(`Previous visits:\n${sessionData.previous_visits_text.trim()}`);

  return {
    // Newline join (not space): a space join lands the language
    // directive mid-paragraph in a run-on block instead of as its own
    // instruction. No golden/contract fixture in this module depends on the
    // space-joined form (`buildPreSummaryPrompt`/`V1_PRE_SUMMARY_TEMPLATE`,
    // which ARE checksum-locked, are untouched by this function).
    system: systemLines.join('\n'),
    user: userSections.join('\n\n'),
  };
}

/**
 * VERBATIM v1 pre-summary system prompt — sha256 `277d94d56d3d`, 336 bytes,
 * extracted from the RUNNING v1 SMR pod (`previous_visit_service.py`), never
 * retyped. In v1 this is the ENTIRE system message for `/presummary`; the
 * template below is the ENTIRE user message.
 */
export const V1_PRE_SUMMARY_SYSTEM_PROMPT: string =
  'You are a medical AI assistant producing clinically relevant, concise, department-aware pre-summaries from EMR context. Format your response with clear sections and bullet points for readability. Include main sections for: Confirmed & Provisional Diagnoses, Investigations, Diagnostics & Trends, Plan of Care and Medications Prescribed.';

/**
 * VERBATIM v1 pre-summary body — sha256 `d1b718001948`, 3155 bytes, extracted
 * from the v1 source of truth (`apps/smr/src/smr/services/previous_visit_service.py`,
 * `_build_pre_summary_prompt`, the f-string at :58-168 after its own `.strip()`).
 * Carries v1's nine single-brace placeholders, substituted at ASSEMBLY time (below).
 *
 * ⚠ This body was WRONG between and its correction: recorded
 * `309a9cd13792` / 3091 bytes as v1's provenance and claimed a running-pod
 * extraction, but that hash is the hash of 's OWN rewritten FORMAT
 * block, not of anything v1 emits. The rest of the body was a faithful port —
 * a byte diff against the v1 source differs in the FORMAT block ALONE. Three
 * things were changed there and are now restored:
 *   - the `Pre-Summary of Medical History` title line was dropped → restored;
 *   - the five headers were reordered → v1's order restored (Diagnoses, Plan of
 *     Care, Investigations, Medications Prescribed, Diagnostics & Trends);
 *   - `Latest Department Note` was renamed `Latest Dept Note` → restored.
 * `PRE_SUMMARY_DISPLAY_TITLES` (`summary-response.mapper.ts`) title-matches this
 * block and MUST change with it — v1 keeps the two identical for the same reason
 * (`previous_visit_service.py:151-163` vs `:215-221`).
 *
 * Pre-summary has NO department and NO visit-type axis in v1: there is exactly
 * ONE body, hardcoded in the service, with department/visit type as VARIABLES
 * inside it. A tenant may override it with a governed `PromptTemplate`
 * the seeded ArcaAI row carries this exact content.
 */
export const V1_PRE_SUMMARY_TEMPLATE: string =
  '## Medical AI Pre-Summary Prompt\n\n> **You are a medical AI assistant tasked with creating a CRISP, CLINICALLY-RELEVANT pre-summary from multiple data sources.\n\nDo not carry over information from any other patient. Treat each request independently..**\n\n---\n\n### ** Contextual data is provided by **\n\n- **Department:** {current_department}\n\n- **Visit Type:** {visit_type}\n\n- **Demographics:** Age {safe_age}, DOB {safe_dob}, Gender {safe_gender}\n\n- **Recent Vitals:** {safe_vitals} (two most recent encounters)\n\n- **Test Results:** {formatted_test_results}\n\n- **Previous Visits:** {formatted_previous_visits}\n\n---\n\n## REQUIREMENTS\n\n### PRIORITIZE:\n\n- Notes from {current_department}\n\n- Most recent encounters\n\n### CAPTURE:\n\n- All provisional and confirmed diagnoses mentioned in any past case note  \n\n- The Plan of Care from the latest note in the current department, documented in full  \n\n- All investigation results reported in the latest department note  \n\n- All medications prescribed in the latest department note, including doses and schedules  \n\n### INCLUDE ONLY clinically significant items:\n\n- Active or ongoing conditions  \n\n- Key treatments and responses  \n\n- Current medications and tolerance  \n\n- Important test results or procedures  \n\n- Allergies/contraindications  \n\n- Notable trends (e.g., weight changes, lab trajectories)  \n\n### EXCLUDE:\n\n- Routine follow-ups without new findings  \n\n- Minor resolved complaints  \n\n- Administrative text  \n\n- Repetitive details  \n\n### STYLE:\n\n- Use bullet points\n\n- Group by clinical importance, not strictly chronology  \n\n- Maintain brevity: keep each bullet to one sentence or phrase\n\n- Language: {language_name}\n\n### INSTRUCTIONS\n\n- Use the following section headers EXACTLY as written (in English) and do NOT translate them.\n- Write ALL bullet content in {language_name}, including any text inside parentheses.\n- Translate ALL English descriptors from context into {language_name}\n- Translate ALL text that appears in parentheses into {language_name}\n- Parentheses Localization Policy: For any parentheses that contain English words, translate them into {language_name}. If a direct translation is unclear, paraphrase briefly in {language_name}. Only leave English inside parentheses for standard clinical abbreviations (BP, HR, RR, Temp, SpO2) and measurement units (°C, mmHg, mg, ml).\n- Do NOT include English words in bullet items or parentheses, except for:\n- Standard clinical abbreviations (e.g., BP, HR, RR, Temp, SpO2)\n- Measurement units (e.g., °C, mmHg, mg, ml)\n- Before finalizing, perform a self-check: scan every pair of parentheses and ensure there are no English words inside (except the allowed abbreviations/units). If any are found, replace them with {language_name} equivalents.\n- Translate or localize any status or qualifier terms or any text inside parentheses into {language_name}.\n\n---\n\n## FORMAT\n\nPre-Summary of Medical History  \n\n- Confirmed & Provisional Diagnoses:  \n\n- Plan of Care (Latest Department Note):  \n\n- Investigations (Latest Department Note):  \n\n- Medications Prescribed (Latest Department Note):  \n\n- Diagnostics & Trends:\n\n---\n\nNow generate the pre-summary.';

/**
 * Substitute v1's single-brace placeholders into a pre-summary body, mapping the
 * v1-compat `PreSummaryRequest` onto the shared variable sources.
 *
 * The substitution itself (single-pass, own-keys-only, unknown tokens passed
 * through unchanged) and v1's per-field defaults live in `@arcaai/applications`
 * so the native Vox v2 path applies exactly the same rules to exactly the same
 * template bodies.
 */
export function renderPreSummaryTemplate(template: string, req: PreSummaryRequest): string {
  return substitutePreSummaryVariables(
    template,
    buildPreSummaryVariables({
      currentDepartment: req.current_department,
      visitType: req.visit_type,
      age: req.age,
      dob: req.dob,
      gender: req.gender,
      vitals: req.formatted_vitals,
      testResults: req.formatted_test_results,
      previousVisits: req.formatted_previous_visits,
      language: req.language,
    }),
  );
}

/**
 * Options for `buildPreSummaryPrompt`.
 */
export interface PreSummaryPromptOptions {
  /**
   * The tenant's governed pre-summary instruction template content (an APPROVED,
   * version-pinned snapshot resolved via `PromptResolutionService` with
   * `promptType: 'pre-summary'`). It REPLACES the v1 body — it does
   * not decorate it — and is interpolated with the same nine variables. Absent ⇒
   * the verbatim v1 body, which is what v1 itself always uses.
   */
  governedInstruction?: string;
  /** The requesting doctor's decrypted DNA writing-style text. */
  dnaStyleText?: string;
}

/**
 * Build the pre-summary `{ system, user }` prompt from a v1 `PreSummaryRequest`.
 *
 * 1:1 with v1: the pre-summary body IS the whole user prompt,
 * sent under v1's dedicated system prompt. v2 adds no competing formatting or
 * language directives — every one of those instructions already lives inside the
 * body, and duplicating them is what produced the drift this ticket corrects.
 *
 * Substitution happens HERE, at assembly time, and nowhere earlier: seed time is
 * impossible (values are per-request) and resolve time would both destroy the
 * version-pinned APPROVED snapshot identity used for audit/diff AND push PHI
 * (DOB, vitals) into anything that logs a resolved prompt. Assembly time keeps
 * the stored template row byte-identical to v1 and confines PHI to the last hop
 * before the SMR call.
 */
export function buildPreSummaryPrompt(req: PreSummaryRequest, options: PreSummaryPromptOptions = {}): AssembledPrompt {
  const governed = options.governedInstruction?.trim();
  const user = renderPreSummaryTemplate(governed || V1_PRE_SUMMARY_TEMPLATE, req);

  // Style guidance only (tone / formatting / phrasing); it never
  // alters clinical facts and is the one v2 addition to v1's system message.
  const dnaStyle = options.dnaStyleText?.trim();
  const system = dnaStyle
    ? `${V1_PRE_SUMMARY_SYSTEM_PROMPT}\n\nMatch this clinician's documentation writing style (tone, formatting, and phrasing) without changing any clinical facts:\n${dnaStyle}`
    : V1_PRE_SUMMARY_SYSTEM_PROMPT;

  return { system, user };
}
