/**
 * Shared v1 pre-summary variable substitution.
 *
 * These are the pure pieces LIFTED OUT of
 * `apps/api/src/modules/text-compat/summary-prompt.builder.ts` so BOTH SDK
 * surfaces can use them (OD-2/OD-3): the compat shim keeps importing them from
 * here, and `PromptAssemblyService` (the native Vox v2 path) uses them too.
 * A second copy would drift, and drift here means literal `{braces}` reaching
 * the LLM on one surface but not the other.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPreSummaryVariables,
  PRE_SUMMARY_TEMPLATE_VARIABLES,
  resolveV1LanguageName,
  substitutePreSummaryVariables,
} from '../pre-summary-variables';

describe('PRE_SUMMARY_TEMPLATE_VARIABLES', () => {
  it("declares exactly v1's nine placeholder names, in v1 declaration order", () => {
    expect([...PRE_SUMMARY_TEMPLATE_VARIABLES]).toEqual([
      'current_department',
      'visit_type',
      'safe_age',
      'safe_dob',
      'safe_gender',
      'safe_vitals',
      'formatted_test_results',
      'formatted_previous_visits',
      'language_name',
    ]);
  });
});

describe('resolveV1LanguageName', () => {
  it("maps through v1's LANGUAGE_MAP on the base subtag; unknown → English", () => {
    expect(resolveV1LanguageName('en')).toBe('English');
    expect(resolveV1LanguageName('ml')).toBe('Malayalam');
    expect(resolveV1LanguageName('ml-IN')).toBe('Malayalam');
    expect(resolveV1LanguageName('ML')).toBe('Malayalam');
    expect(resolveV1LanguageName('fr')).toBe('English');
    expect(resolveV1LanguageName(undefined)).toBe('English');
    expect(resolveV1LanguageName(null)).toBe('English');
    expect(resolveV1LanguageName('   ')).toBe('English');
  });
});

describe('buildPreSummaryVariables', () => {
  it("applies v1's per-field defaults for every absent source", () => {
    expect(buildPreSummaryVariables({})).toEqual({
      current_department: 'General',
      visit_type: 'Medical examination',
      safe_age: 'Unknown',
      safe_dob: 'Unknown',
      safe_gender: 'Unknown',
      safe_vitals: 'Not available',
      formatted_test_results: '',
      formatted_previous_visits: '',
      language_name: 'English',
    });
  });

  it('treats blank / whitespace-only sources as absent (v1 `|| default`)', () => {
    const values = buildPreSummaryVariables({
      currentDepartment: '   ',
      visitType: '',
      age: '  ',
      vitals: '\t',
    });
    expect(values.current_department).toBe('General');
    expect(values.visit_type).toBe('Medical examination');
    expect(values.safe_age).toBe('Unknown');
    expect(values.safe_vitals).toBe('Not available');
  });

  it('passes populated sources through trimmed', () => {
    const values = buildPreSummaryVariables({
      currentDepartment: ' Cardiology ',
      visitType: 'Follow-up',
      age: '58',
      dob: '1968-03-14',
      gender: 'male',
      vitals: 'BP 142/88 mmHg, HR 78 bpm',
      testResults: 'Troponin normal; LDL 150',
      previousVisits: '2026-05-10 Cardiology: HTN review.',
      language: 'ml',
    });
    expect(values).toEqual({
      current_department: 'Cardiology',
      visit_type: 'Follow-up',
      safe_age: '58',
      safe_dob: '1968-03-14',
      safe_gender: 'male',
      safe_vitals: 'BP 142/88 mmHg, HR 78 bpm',
      formatted_test_results: 'Troponin normal; LDL 150',
      formatted_previous_visits: '2026-05-10 Cardiology: HTN review.',
      language_name: 'Malayalam',
    });
  });
});

describe('substitutePreSummaryVariables', () => {
  it('substitutes in ONE pass — a brace sequence inside a value is never re-interpreted', () => {
    const rendered = substitutePreSummaryVariables('Dept={current_department} Vitals={safe_vitals}', {
      current_department: '{safe_vitals}',
      safe_vitals: 'BP 120/80',
    });
    expect(rendered).toBe('Dept={safe_vitals} Vitals=BP 120/80');
  });

  it('leaves an unknown placeholder as written rather than blanking it', () => {
    expect(substitutePreSummaryVariables('{not_a_v1_variable}', {})).toBe('{not_a_v1_variable}');
  });

  it('never resolves an inherited Object.prototype key as a value', () => {
    // `constructor` / `toString` are reachable via `in` but are NOT template
    // variables; substituting them would inject JS source into a clinical prompt.
    expect(substitutePreSummaryVariables('{constructor} {toString}', {})).toBe('{constructor} {toString}');
  });

  it('treats `$&`-style replacement patterns in a value as literal text', () => {
    expect(substitutePreSummaryVariables('{safe_vitals}', { safe_vitals: 'BP $& 120/80 $1' })).toBe('BP $& 120/80 $1');
  });
});
