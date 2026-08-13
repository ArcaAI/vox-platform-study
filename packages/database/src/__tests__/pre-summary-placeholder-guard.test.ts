/**
 * Guard against a de-parameterized pre-summary body.
 *
 * The shipped defect: the governed ArcaAI pre-summary row on
 * dev had its nine v1 `{placeholder}` variables replaced with the literal
 * phrase "provided in the request context". The prompt still PROMISED
 * context ("vitals: provided in the request context") but supplied none, so
 * the model correctly reported that no data was given. Nothing checked this
 * at seed time, so the de-parameterized row shipped and reached the dev
 * cluster undetected.
 *
 * `packages/database` must not depend on `apps/api` or `@arcaai/applications`
 * (verified: `packages/database/package.json` declares neither as a
 * dependency), so the nine-variable list is declared LOCALLY here, following
 * the same precedent already used in
 * `packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-templates.ts`
 * (`PRE_SUMMARY_VARIABLES`, :144-154) — both copies must independently list
 * the same nine names as the shared source of truth,
 * `packages/applications/src/services/consultation/prompt/pre-summary-variables.ts`
 * (`PRE_SUMMARY_TEMPLATE_VARIABLES`). This test asserts THIS package's local
 * copy still matches the seed module's local copy, so the two cannot
 * silently diverge from each other, and separately asserts every seeded
 * pre-summary body actually carries its expected placeholders.
 */
import { describe, expect, it } from 'vitest';

import { PRE_SUMMARY_CONTENT } from '../prisma/db_main/seed/07b-arcaai-clinical-content';
import { ARCAAI_CLINICAL_TEMPLATE_IDS, ARCAAI_CLINICAL_TEMPLATES } from '../prisma/db_main/seed/07b-arcaai-clinical-templates';
import { SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT } from '../prisma/db_main/seed/07-prompt-template';
import { SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT } from '../prisma/db_main/seed/07d-dept-free-pre-summary-default';

/**
 * The nine v1 pre-summary placeholder names, in v1's declaration order.
 * Mirrors `PRE_SUMMARY_TEMPLATE_VARIABLES`
 * (`packages/applications/src/services/consultation/prompt/pre-summary-variables.ts`)
 * and `PRE_SUMMARY_VARIABLES`
 * (`packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-templates.ts`).
 */
const NINE_V1_PLACEHOLDERS = [
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

/** The regression phrase that replaced all nine placeholders when this shipped. */
const REGRESSION_PHRASE = 'provided in the request context';

function placeholdersPresentIn(body: string): string[] {
  return NINE_V1_PLACEHOLDERS.filter((name) => body.includes(`{${name}}`));
}

/**
 * Builds a "de-parameterized" copy of a body the way the shipped defect did:
 * every `{placeholder}` literally replaced with the regression phrase. This
 * is a LOCAL FIXTURE STRING constructed inside the test — it never touches
 * the seed files on disk.
 */
function deParameterize(body: string): string {
  let result = body;
  for (const name of NINE_V1_PLACEHOLDERS) {
    result = result.split(`{${name}}`).join(REGRESSION_PHRASE);
  }
  return result;
}

describe('seeded pre-summary bodies still carry all v1 placeholders', () => {
  it('this package’s local placeholder list matches the seed module’s local list (07b-arcaai-clinical-templates.ts, PRE_SUMMARY_VARIABLES)', () => {
    // `PRE_SUMMARY_VARIABLES` (07b-arcaai-clinical-templates.ts:144-154) is
    // private (not exported), but it is assigned verbatim to the `variables`
    // field of the seeded ArcaAI PRE_SUMMARY template row — the one exported
    // surface that lets us prove the two independently-declared nine-variable
    // lists have not drifted apart, without either package importing the
    // other.
    const preSummaryTemplate = ARCAAI_CLINICAL_TEMPLATES.find(
      (template) => template.id === ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY,
    );
    expect(preSummaryTemplate, 'no ARCAAI_CLINICAL_TEMPLATES row for ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY').toBeDefined();
    expect(preSummaryTemplate!.variables).toEqual([...NINE_V1_PLACEHOLDERS]);
  });

  it('PRE_SUMMARY_CONTENT (07b-arcaai-clinical-content.ts) contains all nine placeholders and not the regression phrase', () => {
    const found = placeholdersPresentIn(PRE_SUMMARY_CONTENT);
    expect(found, `missing placeholders: ${NINE_V1_PLACEHOLDERS.filter((n) => !found.includes(n)).join(', ')}`).toEqual([
      ...NINE_V1_PLACEHOLDERS,
    ]);
    expect(PRE_SUMMARY_CONTENT).not.toContain(REGRESSION_PHRASE);
  });

  it('SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT (07-prompt-template.ts) contains all nine placeholders and not the regression phrase', () => {
    const found = placeholdersPresentIn(SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT);
    expect(found, `missing placeholders: ${NINE_V1_PLACEHOLDERS.filter((n) => !found.includes(n)).join(', ')}`).toEqual([
      ...NINE_V1_PLACEHOLDERS,
    ]);
    expect(SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT).not.toContain(REGRESSION_PHRASE);
  });

  it('SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT (07d-dept-free-pre-summary-default.ts) contains its seven placeholders (deliberately drops current_department and visit_type) and not the regression phrase', () => {
    // Per this file's own header (07d-dept-free-pre-summary-default.ts:20-21),
    // the dept-free fork deliberately drops `{current_department}` and
    // `{visit_type}` — it must NOT carry those two, but must still carry the
    // remaining seven.
    const DEPT_FREE_EXPECTED = NINE_V1_PLACEHOLDERS.filter(
      (name) => name !== 'current_department' && name !== 'visit_type',
    );
    expect(DEPT_FREE_EXPECTED).toHaveLength(7);

    const found = placeholdersPresentIn(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT);
    expect(found, `missing placeholders: ${DEPT_FREE_EXPECTED.filter((n) => !found.includes(n)).join(', ')}`).toEqual(
      DEPT_FREE_EXPECTED,
    );

    // And it must NOT have regained the two dropped axes.
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT).not.toContain('{current_department}');
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT).not.toContain('{visit_type}');
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT).not.toContain(REGRESSION_PHRASE);
  });

  describe('guard self-test — proves the guard actually fails against a de-parameterized body', () => {
    // These three specs pin the CURRENT, correctly-parameterized bodies as
    // fixture strings (captured at write time), de-parameterize a COPY exactly
    // the way the shipped defect did (every `{placeholder}` -> the regression
    // phrase), and assert the guard's own assertions would fail against that
    // copy. Nothing here touches the seed files on disk — the "regression" is a
    // local string only.
    it.each([
      ['PRE_SUMMARY_CONTENT', PRE_SUMMARY_CONTENT],
      ['SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT', SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT],
      ['SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT', SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT],
    ] as const)('%s: a de-parameterized copy fails both the placeholder-presence and regression-phrase checks', (_label, body) => {
      const deParameterized = deParameterize(body);

      // Sanity: de-parameterizing a real (parameterized) body must actually
      // change it — otherwise this "proof" would be vacuous.
      expect(deParameterized).not.toBe(body);

      // The de-parameterized copy carries NONE of the nine placeholders
      // anymore (this is the exact shipped failure mode).
      const foundInBroken = placeholdersPresentIn(deParameterized);
      expect(foundInBroken).toEqual([]);

      // And it now carries the regression phrase — this is what the real
      // guard assertions above (`not.toContain(REGRESSION_PHRASE)`) exist to
      // catch.
      expect(deParameterized).toContain(REGRESSION_PHRASE);
    });
  });
});
