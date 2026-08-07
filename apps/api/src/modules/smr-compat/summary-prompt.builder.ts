import { humanizeField, selectDeptTemplate } from './dept-templates';
import type { PreSummaryRequest } from './dto/pre-summary.request';
import type { PreviousVisitRecordDto, SessionDataDto, TestResultDto } from './dto/session-data.dto';

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
  /** Resolved output language ("en" / "ml"); defaults to English guidance. */
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
   * TASK-592). When present it becomes the authoritative clinical steering and
   * REPLACES the static dept×visit field-set guidance; the v1 wire-schema
   * directive is still appended so the response shape stays Simplified/Enhanced.
   */
  governedInstruction?: string;
  /**
   * The requesting doctor's DNA writing-style text (TASK-599), already decrypted
   * and gate-checked by the controller. When present it is appended as style
   * guidance (tone/formatting/phrasing) — it never alters clinical facts and does
   * NOT change the wire schema. Absent ⇒ no style directive (D5: no doctorId ⇒
   * department + visit-type only).
   */
  dnaStyleText?: string;
}

const LANGUAGE_INSTRUCTION: Record<string, string> = {
  en: 'Write the summary in English.',
  ml: 'Write the summary in English',
};

function languageDirective(language?: string): string {
  const key = (language ?? 'en').toLowerCase();
  return LANGUAGE_INSTRUCTION[key] ?? LANGUAGE_INSTRUCTION.en;
}

/** One rendered transcript line per turn — fixes v1 F2 (whole transcript collapsed into one segment). */
function renderSegments(segments: SessionDataDto['conversation_segments']): string {
  if (!segments || segments.length === 0) {
    return '(no conversation transcript provided)';
  }
  return segments
    .map((seg) => {
      const speaker = seg.speaker?.trim() || 'unknown';
      const text = seg.text?.trim() ?? '';
      return `${speaker}: ${text}`;
    })
    .join('\n');
}

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

  // TASK-592: when the tenant's real Department resolves to a governed,
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
    // v1 department×visit steering (TASK-560 item 2) — the fallback when no real
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

  // TASK-599: the requesting doctor's DNA writing-style, applied to tone /
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
    languageDirective(options.language),
  );

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
    system: systemLines.join(' '),
    user: userSections.join('\n\n'),
  };
}

/**
 * Options for `buildPreSummaryPrompt`.
 */
export interface PreSummaryPromptOptions {
  /**
   * The tenant department's governed pre-summary instruction template content
   * (an APPROVED, version-pinned snapshot resolved via `PromptResolutionService`
   * with `promptType: 'pre-summary'`, TASK-592). When present it steers the
   * pre-summary in addition to the base markdown/format directives.
   */
  governedInstruction?: string;
  /** The requesting doctor's decrypted DNA writing-style text (TASK-599). */
  dnaStyleText?: string;
}

/**
 * Build the pre-summary `{ system, user }` prompt from a v1 `PreSummaryRequest`.
 * Department/visit-type aware; folds explicit pre-formatted context strings, and
 * (TASK-592) the tenant department's governed pre-summary instruction when one
 * resolves. (SMR_Summary_Endpoints.md §4; frozen TASK-560 §5.5.)
 */
export function buildPreSummaryPrompt(req: PreSummaryRequest, options: PreSummaryPromptOptions = {}): AssembledPrompt {
  const department = req.current_department?.trim() || 'General';
  const visitType = req.visit_type?.trim() || 'Medical examination';

  const systemLines = [
    'You are a clinical documentation assistant.',
    `Generate a concise, department-aware pre-summary of a patient's medical history for a ${department} ${visitType}.`,
  ];
  const governed = options.governedInstruction?.trim();
  if (governed) {
    systemLines.push(`Follow this department's pre-summary instruction where the provided context supports it:\n${governed}`);
  }
  const dnaStyle = options.dnaStyleText?.trim();
  if (dnaStyle) {
    systemLines.push(
      `Match this clinician's documentation writing style (tone, formatting, and phrasing) without changing any clinical facts:\n${dnaStyle}`,
    );
  }
  systemLines.push(
    'Organize the pre-summary as markdown with clear section headings and bullet points.',
    'Base it strictly on the provided context; do not fabricate findings.',
    languageDirective(req.language),
  );

  const userSections: string[] = [];

  const demographics: string[] = [];
  if (req.age) demographics.push(`Age: ${req.age}`);
  if (req.dob) demographics.push(`DOB: ${req.dob}`);
  if (req.gender) demographics.push(`Gender: ${req.gender}`);
  if (demographics.length > 0) userSections.push(`Patient:\n${demographics.join(', ')}`);

  if (req.formatted_vitals?.trim()) userSections.push(`Recent vitals:\n${req.formatted_vitals.trim()}`);
  if (req.formatted_test_results?.trim()) userSections.push(`Recent test results:\n${req.formatted_test_results.trim()}`);
  if (req.formatted_previous_visits?.trim()) userSections.push(`Previous visits:\n${req.formatted_previous_visits.trim()}`);

  if (userSections.length === 0) {
    userSections.push('No prior clinical context was provided; produce a brief pre-summary noting the absence of available history.');
  }

  return {
    system: systemLines.join(' '),
    user: userSections.join('\n\n'),
  };
}
