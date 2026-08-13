/**
 * v1 pre-summary template variables — the SHARED substituter.
 *
 * The seeded pre-summary bodies are byte-exact v1 (sha256 `309a9cd13792`,
 * 3091 B) and therefore carry v1's NINE single-brace placeholders. Two surfaces
 * resolve those same bodies and both must interpolate them (OD-2/OD-3):
 *
 *  - the v1-compat shim — `apps/api/src/modules/smr-compat/summary-prompt.builder.ts`,
 *    which imports these functions;
 *  - the native Vox SDK v2 path — `PromptAssemblyService`, reached by BOTH
 *    `SummaryService.generatePreSummary` and `PreSummaryProcessor`.
 *
 * The pure pieces live HERE, in `@arcaai/applications`, because `apps/api`
 * depends on this package and not the reverse — a copy on each side would drift,
 * and drift means literal braces reaching the LLM on one surface but not the
 * other. Framework-free on purpose (no Nest, no DI): it is called from a NestJS
 * service and from a plain builder function alike.
 *
 * Substitution happens at ASSEMBLY time and nowhere earlier: seed time is
 * impossible (values are per-request), and resolve time would both destroy the
 * version-pinned APPROVED snapshot identity used for audit/diff AND push PHI
 * (DOB, vitals) into anything that logs a resolved prompt.
 */

/**
 * The nine variables a v1 pre-summary body may reference, in v1's declaration
 * order. Mirrors what belongs in `PromptTemplate.variables` for a pre-summary
 * template row.
 */
export const PRE_SUMMARY_TEMPLATE_VARIABLES = [
  'current_department',
  'visit_type',
  'safe_age',
  'safe_dob',
  'safe_gender',
  'safe_vitals',
  'formatted_test_results',
  'formatted_previous_visits',
  'language_name',
] as const;

export type PreSummaryVariableName = (typeof PRE_SUMMARY_TEMPLATE_VARIABLES)[number];

/**
 * v1 `LANGUAGE_MAP` (`previous_visit_service.py`): a language CODE is rendered
 * into the prompt by NAME. v1 has no "answer in English" directive
 * D-11: v2 used to carry one for BOTH `en` and `ml`, so every Malayalam request
 * was told to write English.
 */
const V1_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ml: 'Malayalam',
};

/** v1 lookup: base subtag of the language code; anything unmapped → English. */
export function resolveV1LanguageName(language?: string | null): string {
  const key = (language ?? '').trim().toLowerCase().split('-')[0];
  return V1_LANGUAGE_NAMES[key] ?? 'English';
}

/**
 * The raw, surface-specific inputs for the nine variables.
 *
 * Field names are surface-neutral (the compat DTO and the native consultation
 * context spell them differently); the v1 placeholder names and v1's defaults
 * are applied by {@link buildPreSummaryVariables}, once, for both.
 */
export interface PreSummaryVariableSources {
  currentDepartment?: string | null;
  visitType?: string | null;
  age?: string | null;
  dob?: string | null;
  gender?: string | null;
  vitals?: string | null;
  testResults?: string | null;
  previousVisits?: string | null;
  language?: string | null;
}

/** v1's `|| default` semantics: blank / whitespace-only counts as absent. */
function orDefault(value: string | null | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

/**
 * v1's per-field fallbacks (`_build_pre_summary_prompt`), applied verbatim.
 * A surface that has no equivalent for a field simply omits it and inherits v1's
 * default — never a newly invented one.
 */
export function buildPreSummaryVariables(sources: PreSummaryVariableSources): Record<PreSummaryVariableName, string> {
  return {
    current_department: orDefault(sources.currentDepartment, 'General'),
    visit_type: orDefault(sources.visitType, 'Medical examination'),
    safe_age: orDefault(sources.age, 'Unknown'),
    safe_dob: orDefault(sources.dob, 'Unknown'),
    safe_gender: orDefault(sources.gender, 'Unknown'),
    safe_vitals: orDefault(sources.vitals, 'Not available'),
    formatted_test_results: orDefault(sources.testResults, ''),
    formatted_previous_visits: orDefault(sources.previousVisits, ''),
    language_name: resolveV1LanguageName(sources.language),
  };
}

/** v1's single-brace placeholder syntax. */
const V1_PLACEHOLDER_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Substitute v1's single-brace placeholders into a pre-summary body.
 *
 * Deliberately NOT `interpolateTemplate` (`prompt-management.service.ts`): that
 * one is `{{var}}` and runs on the template TEST path only, so a v1 body would
 * pass through untouched and literal braces would reach the LLM (D-08).
 *
 * ONE pass, OWN keys only:
 *  - a brace sequence appearing inside a substituted value (clinical free text
 *    can contain anything) is never re-interpreted;
 *  - an unknown `{token}` is left as written rather than silently blanked;
 *  - an inherited `Object.prototype` key (`{constructor}`, `{toString}`) is NOT
 *    a variable and is left as written.
 *
 * The replacement is supplied by a callback, so `$&`/`$1` sequences inside a
 * value stay literal text.
 */
export function substitutePreSummaryVariables(template: string, values: Record<string, string>): string {
  return template.replace(V1_PLACEHOLDER_PATTERN, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match,
  );
}

/**
 * Does this body reference any of the nine v1 placeholders?
 *
 * Lets a caller pay for the extra context lookups (department name, …) only
 * when the resolved body actually needs them.
 */
export function templateReferencesPreSummaryVariables(template: string): boolean {
  return PRE_SUMMARY_TEMPLATE_VARIABLES.some((name) => template.includes(`{${name}}`));
}
