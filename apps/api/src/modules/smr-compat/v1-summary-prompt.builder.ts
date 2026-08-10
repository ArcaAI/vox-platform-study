import { normalizeVisitType, resolveDepartmentKey, type VisitTypeKey } from './dept-templates';
import type { PreSummaryRequest } from './dto/pre-summary.request';
import type { PreviousVisitRecordDto, SessionDataDto, TestResultDto } from './dto/session-data.dto';
import { buildPreSummaryPrompt, type AssembledPrompt, type PreSummaryPromptOptions } from './summary-prompt.builder';
import {
  V1_DEPT_VISIT_SCHEMAS,
  V1_JSON_RESPONSE_SPEC_FALLBACK_JSON,
  V1_JSON_RULES_WITH_SCHEMA_TEMPLATE,
  V1_PRIOR_MEDICAL_CONTEXT_PREFIX,
  V1_SUMMARY_SYSTEM_PROMPT,
  V1_SUMMARY_USER_PROMPT_TEMPLATE,
  type V1DeptVisitSchema,
} from './v1-wrapper';

/**
 * v1-ONLY summary prompt assembly for the compat surfaces (SDK-compat and
 * API-compat), replacing `buildSummaryPrompt` on those two routes.
 *
 * ## Why a second builder exists
 *
 * `buildSummaryPrompt` cannot make the LLM follow an instruction template, and
 * no amount of prompt wording fixes it — the defect is structural.
 *
 * In v1, the instruction template and the JSON response shape were a MATCHED
 * PAIR. `summary_service.py:212` selected the department × visit-type body,
 * then `JsonPromptFactory.build_template_by_department` wrapped it with a
 * per-(department × visit-type) schema whose keys mirror that body's headings.
 * The template said "produce these 14 sections"; the schema said "emit exactly
 * these 14 keys". They agreed, so the model complied.
 *
 * v2 kept only half of that. `buildSummaryPrompt` injects the template as
 * ADVISORY text — "follow this instruction where the transcript supports it,
 * and map the resulting content into the generic summary fields defined by the
 * schema (do not add fields outside the schema)" — while the controller binds
 * `response_format.json_schema` to the generic Simplified/Enhanced schema with
 * `strict: true`. Provider structured output is a hard constraint and always
 * wins over prose, so a Surgery template asking for 14 numbered headings is
 * squeezed into 8 generic keys (`chief_complaint`, `symptoms`, `assessment`, …).
 * The template's structure is not merely ignored, it is UNREPRESENTABLE in the
 * response. That is the reported "does not follow the instruction template".
 *
 * This builder restores v1's matched pair: the department body becomes the
 * PREFACE (v1's own term), the schema it implies is emitted both inside the
 * prompt (v1's `STRICT JSON RESPONSE FORMAT` block) and as the wire-level
 * `response_format` (`responseSchema` below), so prompt and constraint agree
 * by construction.
 *
 * ## What it is built from
 *
 * Not invented here. The five wrapper artifacts in `./v1-wrapper` were ported
 * byte-exact from the running v1 pod by TASK-634 Phase 5 and deliberately left
 * UNWIRED pending this assembly step (see `v1-wrapper/index.ts` "WIRING
 * STATUS"). This module is that step; it adds no prompt text of its own beyond
 * the two v2-specific carry-overs called out below.
 *
 * ## Deliberate v2 carry-overs (NOT v1 behaviour — do not "restore" them)
 *
 * 1. **Output language is English** (TASK-650 R1). v1's artifacts carry a
 *    `{conversation_language}` placeholder and a monolingual policy that would
 *    otherwise write the note in the transcript's language. Rather than append a
 *    competing directive — which is what produced the drift TASK-634 corrected —
 *    the placeholder itself is substituted with `English`, so every one of v1's
 *    own language lines states the requirement in v1's own words.
 * 2. **The bilingual-transcript directive** (TASK-651). Sarvam mistranslations
 *    changed a drug and inverted a severity on a real consultation; the original
 *    line stays authoritative for clinical facts.
 *
 * ## Verified against the v1 source (2026-08-10)
 *
 * Assembly order below was cross-checked line-by-line against the v1 checkout
 * at `ARCAAI/HOPE/docs/apps/smr/src/smr/` and matches:
 *
 * ```python
 * # summary_service.py:234-236
 * dept_preface = dept_template.content.strip()
 * user_prompt_text = f"{dept_preface}\n\n{tmpl['user']}"
 * # prompts_json.py:434
 * user = base_user + prior_context + "\n\n" + json_rules
 * ```
 *
 * Which confirms the answer to "does v1 have a different schema per prompt
 * template?" — YES. `get_department_schema(department, visit_type)`
 * (`prompts_json.py:264`) returns a DISTINCT key set per (department ×
 * visit_type) from `DEPT_VISIT_SCHEMAS`, rendered into the prompt as
 * `schema_example` under "Conform EXACTLY to this JSON schema". The template
 * and the schema were always a pair.
 *
 * ### Deliberate deviation: the schema is ALSO enforced at the wire
 *
 * v1 sends NO `response_format` — grep for `response_format`/`json_schema` in
 * `summary_service.py` returns nothing; it relied on prompt text alone. This
 * module additionally returns `responseSchema` for
 * `response_format.json_schema`, because prompt-only enforcement is exactly
 * what was observed to fail, and v2 already has the structured-output plumbing
 * v1 lacked. The two never disagree — both are generated from the same schema
 * dict — so this strengthens v1's intent rather than changing it.
 *
 * ### Known checkout-vs-pod divergence in the fallback
 *
 * In the CHECKOUT, `get_department_schema` returns `{}` for an unrecognized
 * department, making v1's WITHOUT-SCHEMA prompt branch live. The pod-extracted
 * artifacts in `./v1-wrapper` record the fallback as the always-truthy
 * `JSON_RESPONSE_SPEC` (SOAP) instead. The two v1 sources are known to have
 * diverged (TASK-634 §2.2, §2.9) and the POD is authoritative, so the SOAP
 * fallback is used here. It is also the better failure mode: an unrecognized
 * department still gets a defined four-field shape rather than an unconstrained
 * one.
 *
 * `buildSummaryPrompt` is left untouched for the native Vox v2 path.
 */

/** An assembled v1 prompt plus the response schema that must accompany it. */
export interface V1AssembledSummaryPrompt extends AssembledPrompt {
  /**
   * JSON Schema for `response_format.json_schema`, derived from the SAME v1
   * department schema the prompt embeds. Sending the prompt without this — or
   * with any other schema — reintroduces the exact defect this module fixes.
   */
  responseSchema: Record<string, unknown>;
  /** Which v1 department schema was resolved (`null` ⇒ the SOAP fallback). */
  resolvedDepartmentKey: string | null;
  /** The v1 visit-type bucket the schema was selected with. */
  resolvedVisitType: VisitTypeKey;
}

export interface V1SummaryPromptOptions {
  department?: string;
  visitType?: string;
  /**
   * Whether pre-summary enrichment is enabled (decided by the controller per
   * SMR_Summary_Endpoints.md §3.1). When true, `pre_summary_text` is injected
   * under v1's `PRIOR MEDICAL CONTEXT` prefix.
   */
  includePreSummary?: boolean;
  /**
   * The tenant department's governed instruction template content — for the
   * ArcaAI tenant this IS the byte-exact v1 department body (seeded by
   * TASK-592 from `07b-arcaai-clinical-content.ts`). It becomes the PREFACE,
   * exactly as v1 places it. Absent ⇒ no preface, which is also a real v1 state:
   * four of v1's eleven departments carry a schema with no body content.
   */
  governedInstruction?: string;
  /** The requesting doctor's decrypted DNA writing-style text (TASK-599). */
  dnaStyleText?: string;
}

/**
 * The output language of the clinical note (TASK-650 R1, owner decision
 * 2026-08-10). Substituted into v1's `{conversation_language}` placeholder so
 * v1's own monolingual-policy lines carry the requirement — see carry-over 1 in
 * the module docstring.
 */
const V1_CONVERSATION_LANGUAGE = 'English';

/**
 * TASK-651 — verified live on `hope-v2-dev` 2026-08-10 against one real `ml-en`
 * consultation: Sarvam alone turned `aceclofenac 100 mg PRN` into
 * "Acetaminophen 100 mg" (a DIFFERENT DRUG) and `marked … subchondral sclerosis`
 * into "mild" (an inverted severity), and dropped findings and a proper noun.
 * The translation stays — it is what makes the note readable English — but it
 * stops being the sole source. Carried over verbatim from `buildSummaryPrompt`;
 * the two must not diverge.
 */
const V1_BILINGUAL_TRANSCRIPT_DIRECTIVE =
  'Each transcript turn may appear twice: a machine translation, followed by a line marked "(original, untranslated)" carrying the speaker\'s own words. ' +
  'The machine translation is not clinically reliable — it has been observed to substitute one drug for another, invert severity qualifiers, and drop findings and proper nouns. ' +
  'Use the translation only to follow the conversation. For every clinical fact — drug names, doses, routes, frequencies, numbers, measurements, scores, severity qualifiers, anatomical sites, and proper nouns — take the value from the original line whenever the two disagree, and render it in English yourself.';

/**
 * The four departments v1 carries a SCHEMA for but no body template
 * (TASK-634 D-14/D-15). `resolveDepartmentKey` knows only the seven that have
 * bodies, because that is all `dept-templates.ts` needs; the schema table has
 * eleven. Resolved here rather than by widening `resolveDepartmentKey`, whose
 * return type is the seven-key `DepartmentKey` union consumed by the untouched
 * `buildSummaryPrompt` path.
 */
const V1_SCHEMA_ONLY_DEPARTMENTS: Record<string, string> = {
  dermatology: 'dermatology',
  derm: 'dermatology',
  dietetics: 'dietetics',
  dietician: 'dietetics',
  dietitian: 'dietetics',
  nutrition: 'dietetics',
  nephrology: 'nephrology',
  nephro: 'nephrology',
  'renal medicine': 'nephrology',
  'surgical oncology': 'surgical_oncology',
  surgical_oncology: 'surgical_oncology',
  'surgical-oncology': 'surgical_oncology',
  'onco surgery': 'surgical_oncology',
};

/**
 * Resolve a free-form department name to one of v1's ELEVEN schema slugs, or
 * `null` for the generic SOAP fallback. Tries the seven body-carrying
 * departments first (reusing the audited v1 alias tables in
 * `dept-templates.ts`), then the four schema-only ones.
 */
export function resolveV1SchemaDepartment(department?: string | null): string | null {
  const bodyDept = resolveDepartmentKey(department);
  if (bodyDept) return bodyDept;
  const dept = (department ?? '').trim().toLowerCase();
  return V1_SCHEMA_ONLY_DEPARTMENTS[dept] ?? null;
}

/**
 * The v1 schema dict for a department × visit type, or v1's generic
 * `JSON_RESPONSE_SPEC` fallback (subjective/objective/assessment/plan) when the
 * department is not one of the eleven. v1 NEVER resolves to an empty schema,
 * which is why its WITHOUT-SCHEMA prompt branch is dead code in the pod.
 */
function selectV1Schema(deptKey: string | null, visitType: VisitTypeKey): V1DeptVisitSchema {
  const schema = deptKey ? V1_DEPT_VISIT_SCHEMAS[deptKey]?.[visitType] : undefined;
  return schema ?? (JSON.parse(V1_JSON_RESPONSE_SPEC_FALLBACK_JSON) as V1DeptVisitSchema);
}

/**
 * Convert a v1 schema dict (field name → free-text type descriptor such as
 * `"string (markdown)"`) into a strict JSON Schema for
 * `response_format.json_schema`.
 *
 * Every field is a required, non-nullable string in v1's ORIGINAL key order,
 * and `additionalProperties` is false. That combination is what makes the model
 * emit the template's sections and nothing else. It also satisfies Azure/OpenAI
 * strict-mode structured outputs, which require every declared property to be
 * listed in `required` (see `summary-schemas.ts`) — so no field may be made
 * optional here. v1's own rule block already tells the model what to write when
 * a section has no content ("write a brief sentence indicating absence"), which
 * is why a nullable field is neither needed nor wanted: a `null` section would
 * read as "not applicable" rather than "not discussed".
 *
 * `title` mirrors the resolved department/visit so the provider's schema name is
 * stable and legible in provider-side logs.
 */
export function toStrictJsonSchema(schema: V1DeptVisitSchema, title: string): Record<string, unknown> {
  const keys = Object.keys(schema);
  return {
    title,
    type: 'object',
    properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
    required: keys,
    additionalProperties: false,
  };
}

/**
 * Substitute v1's single-brace `str.format()` tokens and unescape its doubled
 * braces.
 *
 * Both halves are required. `V1_SUMMARY_USER_PROMPT_TEMPLATE` embeds a literal
 * JSON example wrapped in Python's `{{`/`}}` escapes; `str.format()` collapses
 * those to `{`/`}` before the prompt is ever sent, so skipping the unescape ships
 * a malformed JSON example to the model. Values are substituted with a replacer
 * function so a `$&` or `$1` inside clinical text is never interpreted as a
 * `String.replace` capture reference.
 */
export function substituteV1Tokens(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [token, value] of Object.entries(values)) {
    out = out.split(`{${token}}`).join(value);
  }
  return out.split('{{').join('{').split('}}').join('}');
}

/** Does any turn carry an original alongside a machine translation of it? */
function hasBilingualTurns(segments: SessionDataDto['conversation_segments']): boolean {
  return (segments ?? []).some((seg) => {
    const original = seg.original_text?.trim();
    return Boolean(original) && original !== (seg.text?.trim() ?? '');
  });
}

/**
 * One rendered transcript line per turn — plus, when the turn was machine
 * translated, a second line carrying the clinician's original words (suppressed
 * when identical, so an English consultation renders unchanged).
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

/**
 * v1's `{patient_info}` block. v1 passes a formatted patient string; v2's
 * `session_data` carries a free-form `patient_info` map plus structured test
 * results and previous visits that v1 folded in upstream. All three are
 * rendered here so no clinical context reaching the gateway is dropped on the
 * floor (TASK-652 §3.1 — a live request carrying real vitals/labs/prior visits
 * produced "No contextual patient data were provided").
 */
function renderPatientInfo(sessionData: SessionDataDto): string {
  const blocks: string[] = [];

  const info = sessionData.patient_info;
  if (info && Object.keys(info).length > 0) {
    blocks.push(
      Object.entries(info)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(', '),
    );
  }

  const structuredTests = renderTestResults(sessionData.test_results);
  if (structuredTests) blocks.push(`Test results:\n${structuredTests}`);
  else if (sessionData.test_results_text?.trim()) blocks.push(`Test results:\n${sessionData.test_results_text.trim()}`);

  const structuredVisits = renderPreviousVisits(sessionData.previous_visits);
  if (structuredVisits) blocks.push(`Previous visits:\n${structuredVisits}`);
  else if (sessionData.previous_visits_text?.trim()) blocks.push(`Previous visits:\n${sessionData.previous_visits_text.trim()}`);

  return blocks.length > 0 ? blocks.join('\n\n') : '(no structured patient information provided)';
}

/**
 * Build the v1 summary `{ system, user, responseSchema }` triple.
 *
 * Assembly order is v1's (`JsonPromptFactory.build_template_by_department`):
 *
 *   system = V1_SUMMARY_SYSTEM_PROMPT [+ bilingual directive] [+ DNA style]
 *   user   = <department body PREFACE>
 *          + V1_SUMMARY_USER_PROMPT_TEMPLATE (5 tokens substituted)
 *          + PRIOR MEDICAL CONTEXT (when enrichment is on)
 *          + STRICT JSON RESPONSE FORMAT (carrying the department schema)
 *
 * The order is load-bearing, not cosmetic. v1's user-prompt scaffold contains a
 * GENERIC four-field SOAP example, and the department schema must therefore come
 * AFTER it: the rule block's "Conform EXACTLY to this JSON schema" is what
 * overrides the earlier example. Emitting them the other way round makes every
 * department produce SOAP.
 */
export function buildV1SummaryPrompt(sessionData: SessionDataDto, options: V1SummaryPromptOptions = {}): V1AssembledSummaryPrompt {
  const deptKey = resolveV1SchemaDepartment(options.department);
  const visitType = normalizeVisitType(options.visitType);
  const schema = selectV1Schema(deptKey, visitType);

  // ── system ────────────────────────────────────────────────────────────────
  const systemLines = [V1_SUMMARY_SYSTEM_PROMPT];
  if (hasBilingualTurns(sessionData.conversation_segments)) {
    systemLines.push(V1_BILINGUAL_TRANSCRIPT_DIRECTIVE);
  }
  const dnaStyle = options.dnaStyleText?.trim();
  if (dnaStyle) {
    systemLines.push(
      `Match this clinician's documentation writing style (tone, formatting, and section phrasing) without changing any clinical facts:\n${dnaStyle}`,
    );
  }

  // ── user ──────────────────────────────────────────────────────────────────
  const userParts: string[] = [];

  // 1. The department body PREFACE — v1's term. This is the instruction
  //    template the model must follow, placed first and unmodified.
  const preface = options.governedInstruction?.trim();
  if (preface) userParts.push(preface);

  // 2. v1's user-prompt scaffold, with all five per-request tokens resolved.
  userParts.push(
    substituteV1Tokens(V1_SUMMARY_USER_PROMPT_TEMPLATE, {
      session_id: sessionData.session_id?.trim() || '(not provided)',
      session_date: sessionData.created_at?.trim() || new Date().toISOString(),
      patient_info: renderPatientInfo(sessionData),
      conversation_text: renderSegments(sessionData.conversation_segments),
      conversation_language: V1_CONVERSATION_LANGUAGE,
    }),
  );

  let user = userParts.join('\n\n');

  // 3. Pre-summary enrichment, under v1's authoritative-context prefix. A plain
  //    concatenation, not a template — the prefix carries its own newlines.
  if (options.includePreSummary && sessionData.pre_summary_text?.trim()) {
    user += V1_PRIOR_MEDICAL_CONTEXT_PREFIX + sessionData.pre_summary_text.trim();
  }

  // 4. The STRICT JSON RESPONSE FORMAT block, carrying the department schema.
  //    Python's `json.dumps(indent=2)` and `JSON.stringify(value, null, 2)`
  //    agree byte-for-byte on these ASCII-only dicts.
  //
  //    The explicit `\n\n` is v1's, not a typo: `build_template_by_department`
  //    ends with `base_user + prior_context + "\n\n" + json_rules`, and
  //    `json_rules` ALREADY opens with its own `\n\n` — so v1 emits four
  //    newlines before the block. Reproduced rather than tidied; the whole
  //    point of this module is to stop diverging from v1 by small increments.
  user += '\n\n';
  user += substituteV1Tokens(V1_JSON_RULES_WITH_SCHEMA_TEMPLATE, {
    conversation_language: V1_CONVERSATION_LANGUAGE,
    schema_example: JSON.stringify(schema, null, 2),
  });

  return {
    system: systemLines.join('\n\n'),
    user,
    responseSchema: toStrictJsonSchema(schema, `V1Summary_${deptKey ?? 'generic'}_${visitType}`),
    resolvedDepartmentKey: deptKey,
    resolvedVisitType: visitType,
  };
}

/**
 * Adherence directive for the v1 pre-summary, appended to the SYSTEM message.
 *
 * The pre-summary BODY is checksum-locked and byte-exact from v1
 * (`V1_PRE_SUMMARY_TEMPLATE`), and TASK-634 established that duplicating its
 * instructions into the system message is what produced drift — so nothing here
 * restates a formatting, language, or content rule. It states only the ONE thing
 * the body cannot state about itself: that its FORMAT block is a hard contract
 * rather than a suggestion. That matters because the pre-summary is parsed by
 * exact title match (`PRE_SUMMARY_DISPLAY_TITLES`), and a renamed, reordered, or
 * omitted header is silently absorbed into the preceding section and the rest
 * padded with "Not available".
 */
const V1_PRE_SUMMARY_ADHERENCE_DIRECTIVE =
  'Follow the instruction template in the user message EXACTLY. Reproduce the section headers from its FORMAT block verbatim, in the order given, including every one of them. Do not rename, merge, reorder, or omit a header, and do not introduce headers of your own.';

/**
 * Build the v1 pre-summary prompt with the adherence directive applied.
 *
 * Thin wrapper over `buildPreSummaryPrompt` — the body, its substitution, and
 * the governed-template override are unchanged, so the checksum-locked v1
 * template and its `PRE_SUMMARY_DISPLAY_TITLES` parser stay in lockstep. Only
 * the system message gains the directive above (the same slot TASK-599 already
 * uses for DNA style).
 */
export function buildV1PreSummaryPrompt(req: PreSummaryRequest, options: PreSummaryPromptOptions = {}): AssembledPrompt {
  const { system, user } = buildPreSummaryPrompt(req, options);
  return { system: `${system}\n\n${V1_PRE_SUMMARY_ADHERENCE_DIRECTIVE}`, user };
}
