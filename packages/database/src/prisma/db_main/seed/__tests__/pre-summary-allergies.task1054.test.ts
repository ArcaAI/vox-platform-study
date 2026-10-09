/**
 * TASK-1054 defect B — the ArcaAI warm-start pre-summary must carry allergies and family history.
 *
 * Found by the 2026-10-09 e2e: "Allergy: penicillin (rash)" and the family history in the previous
 * case note were dropped, because the FORMAT allowed exactly five headings and allergies sat only in
 * an INCLUDE ONLY list with no heading. This pins the two added headings, the mandatory CAPTURE
 * bullets, and that no "five headings" wording survives to forbid them.
 */
import { describe, expect, it } from 'vitest';

import { ARCAAI_CLINICAL_TEMPLATES, ARCAAI_CLINICAL_TEMPLATE_IDS } from '../07b-arcaai-clinical-templates';

const body = String(ARCAAI_CLINICAL_TEMPLATES.find((template) => template.id === ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY)!.content);

const format = body.slice(body.indexOf('## FORMAT'));
const capture = body.slice(body.indexOf('### CAPTURE:'), body.indexOf('### INCLUDE ONLY'));

describe('TASK-1054 B — ArcaAI pre-summary FORMAT and CAPTURE', () => {
  it('lists the seven headings, Allergies first and Family History after Diagnoses', () => {
    const headings = [...format.matchAll(/^- (.+):$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      'Allergies & Contraindications',
      'Confirmed & Provisional Diagnoses',
      'Family History',
      'Investigations (Latest Dept Note)',
      'Diagnostics & Trends',
      'Plan of Care (Latest Dept Note)',
      'Medications Prescribed (Latest Dept Note)',
    ]);
  });

  it('makes allergies/contraindications and family history mandatory CAPTURE items', () => {
    expect(capture).toMatch(/allerg/i);
    expect(capture).toContain('No known allergies documented');
    expect(capture).toMatch(/family history/i);
  });

  it('no longer caps the output at "five headings"', () => {
    expect(body).not.toMatch(/five headings/i);
    expect(body).toContain('Output the headings below and nothing else');
  });
});
