/**
 * TASK-1054 defect C — the department-free pre-summary (served to native / ALaaS callers) must carry
 * allergies and family history. The 2026-10-09 e2e still showed a pre-summary without allergies after
 * the ArcaAI department-corpus template was fixed, because the native path reads this 'dept-free' body.
 */
import { describe, expect, it } from 'vitest';

import { SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT } from '../07d-dept-free-pre-summary-default';

const body = SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT;
const format = body.slice(body.indexOf('## FORMAT'));
const capture = body.slice(body.indexOf('### CAPTURE:'), body.indexOf('### INCLUDE ONLY'));

describe('TASK-1054 C — dept-free pre-summary FORMAT and CAPTURE', () => {
  it('lists the seven headings, Allergies first and Family History after Diagnoses', () => {
    const headings = [...format.matchAll(/^- (.+):\s*$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      'Allergies & Contraindications',
      'Confirmed & Provisional Diagnoses',
      'Family History',
      'Plan of Care (Latest Note)',
      'Investigations (Latest Note)',
      'Medications Prescribed (Latest Note)',
      'Diagnostics & Trends',
    ]);
  });

  it('makes allergies/contraindications and family history mandatory CAPTURE items', () => {
    expect(capture).toMatch(/allerg/i);
    expect(capture).toContain('No known allergies documented');
    expect(capture).toMatch(/family history/i);
  });

  it('never caps the output at "five" headings', () => {
    expect(body).not.toMatch(/five (FORMAT )?(headings|items)/i);
  });
});
