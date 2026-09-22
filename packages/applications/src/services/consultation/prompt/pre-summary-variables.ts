/**
 * v1 pre-summary template variables — the VALUE builders, plus the v1-COMPAT-ONLY substituter.
 *
 * ## What TASK-890 changed here, and what it deliberately did not
 *
 * The nine v1 names are still built the same way, by the same defaults, and
 * `PromptAssemblyService` still populates them — §3.4 keeps the VALUE builders
 * verbatim, because the assembled bytes must not move.
 *
 * What moved is the RENDERER. The native Vox v2 consultation path renders through the ONE
 * grammar (`renderTemplate`, §3.2) over the `context.*` namespace the tenant's
 * `consultation_legacy_v1` schema clone declares, so it no longer calls
 * {@link substitutePreSummaryVariables} at all.
 *
 * That function survives for exactly ONE caller: the FROZEN v1-compat plane
 * (`apps/api/src/modules/text-compat/summary-prompt.builder.ts`), whose
 * `V1_PRE_SUMMARY_TEMPLATE` is a byte-exact v1 literal carrying v1's single-brace
 * placeholders and is pinned by a checksum test. It is a compatibility contract, not a
 * templating flavour anyone may reach for: **do not add a new caller.** Retiring it means
 * moving it into the compat module and converting the governed bodies that surface renders
 * — a follow-up outside this lane's ownership.
 *
 * The pure pieces live HERE, in `@arcaai/applications`, because `apps/api` depends on this
 * package and not the reverse. Framework-free on purpose (no Nest, no DI).
 *
 * Substitution happens at ASSEMBLY time and nowhere earlier: seed time is
 * impossible (values are per-request), and resolve time would both destroy the
 * version-pinned APPROVED snapshot identity used for audit/diff AND push PHI
 * (DOB, vitals) into anything that logs a resolved prompt.
 *
 * TASK-1001 OD-2: {@link resolveV1LanguageName} used to be its OWN resolver, disagreeing with
 * `summaryLanguageName` (`../consultation/summary-language.ts`) on the absent case — it silently
 * defaulted every unmapped or undeclared tag to `'English'`. It is now a thin wrapper over the
 * ONE shared resolver, {@link resolveSummaryLanguage}; see that function's docstring for the
 * resolution order. Absent, blank, or a rejected code-switch tag (`ml-en`) now returns `null`,
 * never a silently invented `'English'`.
 */

import { resolveSummaryLanguage } from '../consultation/summary-language';

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
 * v1's language-name lookup (`previous_visit_service.py`'s `LANGUAGE_MAP`), now a thin wrapper
 * over the ONE shared resolver ({@link resolveSummaryLanguage}, TASK-1001 OD-2). It used to be a
 * standalone `Record<string, string>` lookup that defaulted every unmapped OR absent tag to
 * `'English'` — that silent default was the bug this ticket removes (§A2: it disagreed with
 * `summaryLanguageName`, which already returned `null` for absent). There is no consultation
 * metadata on this path, so only `configuredLanguage` (the raw v1 language code) is passed;
 * `null` propagates instead of being coerced.
 */
export function resolveV1LanguageName(language?: string | null): string | null {
  return resolveSummaryLanguage(language, null);
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
 *
 * `language_name` is the one exception to "verbatim": TASK-1001 OD-2 removed
 * {@link resolveV1LanguageName}'s silent `'English'` default, so an undeclared language now
 * resolves to `null` there; this is the ONE place that folds it to `''` (like
 * `formatted_test_results`/`formatted_previous_visits` above) so the record stays
 * `Record<PreSummaryVariableName, string>` — never a re-invented `'English'`.
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
    language_name: resolveV1LanguageName(sources.language) ?? '',
  };
}

/** v1's single-brace placeholder syntax. */
const V1_PLACEHOLDER_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Substitute v1's single-brace placeholders into a pre-summary body.
 *
 * TASK-890 §3.11: this is the LAST single-brace renderer in the monorepo, kept only for the
 * frozen v1-compat body described in the module docstring. Everything else — the consultation
 * assembly path, the prompt test, the agent lanes and the harness — renders `{{ path }}`
 * through `renderTemplate` in `@arcaai/workflow-contract`.
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
