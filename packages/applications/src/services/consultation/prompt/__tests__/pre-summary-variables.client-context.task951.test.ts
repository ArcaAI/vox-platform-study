/**
 * TASK-951 D-7 / OD-5 — the two builder SOURCES the realtime lane now supplies.
 *
 * ## Why this file exists beside `pre-summary-variables.test.ts`
 *
 * `PreSummaryVariableSources.vitals` and `.previousVisits` have been declared since TASK-890, and
 * until TASK-951 NO surface passed either: the v2 data model held no vitals and no prior-visit
 * text, so both inherited v1's own defaults (`Not available` / `''`) and the fields were, in
 * effect, dead parameters. Since TASK-951 the realtime lane fills them from the client's `vitals`
 * and `previous_case_notes` context kinds, and `LiveDocumentationService.realtimeRunContext`
 * relies on THIS builder — rather than a second copy of v1's `|| default` semantics — to decide
 * what an absent value means.
 *
 * That makes the two fields load-bearing. Deleting them as unused, or changing what a blank one
 * means, would silently return the realtime prompt to "Not available" for a consultation whose
 * clinic measured and sent the readings. These assertions are what makes that a failing test
 * rather than a quiet regression, and they deliberately state the SEMANTICS (blank is absent;
 * absent is v1's own default), never new behaviour of their own.
 */
import { describe, expect, it } from 'vitest';

import { buildPreSummaryVariables, PRE_SUMMARY_TEMPLATE_VARIABLES } from '../pre-summary-variables';

describe('TASK-951 — buildPreSummaryVariables carries the client-supplied clinical sources', () => {
  it('renders a supplied vitals line as `safe_vitals`, verbatim', () => {
    const vitals = 'BP 128/82 mmHg · HR 72 bpm · RR 16 /min · Temp 37.1 °C · SpO2 98 %';

    expect(buildPreSummaryVariables({ vitals }).safe_vitals).toBe(vitals);
  });

  it('keeps a MULTI-LINE vitals value intact — the notes line must survive the trim', () => {
    // The renderer puts free-text `notes` on a second line; an inner-whitespace-collapsing
    // "normalisation" here would silently merge the readings and the note into one line.
    const vitals = 'BP 128/82 mmHg · HR 72 bpm\nTaken at triage, patient seated.';

    expect(buildPreSummaryVariables({ vitals }).safe_vitals).toBe(vitals);
  });

  it('renders supplied previous visits as `formatted_previous_visits`, verbatim', () => {
    const previousVisits = '2026-07-19 · General Medicine · Dr Menon · Follow-up\nBP controlled on amlodipine.';

    expect(buildPreSummaryVariables({ previousVisits }).formatted_previous_visits).toBe(previousVisits);
  });

  it("treats blank and whitespace-only as ABSENT, inheriting v1's own defaults", () => {
    for (const blank of [undefined, null, '', '   ', '\n\t']) {
      const built = buildPreSummaryVariables({ vitals: blank, previousVisits: blank });
      expect(built.safe_vitals).toBe('Not available');
      expect(built.formatted_previous_visits).toBe('');
    }
  });

  it('the two sources are independent — supplying one never fills the other', () => {
    expect(buildPreSummaryVariables({ vitals: 'HR 64 bpm' }).formatted_previous_visits).toBe('');
    expect(buildPreSummaryVariables({ previousVisits: 'Prior note.' }).safe_vitals).toBe('Not available');
  });

  it('adds no name and moves none: the nine v1 placeholders are exactly what is built', () => {
    const built = buildPreSummaryVariables({ vitals: 'HR 64 bpm', previousVisits: 'Prior note.' });

    // The builder is the shared surface for the compat plane, native assembly AND the realtime
    // lane — a tenth key here would reach a frozen v1 body that never declared it.
    expect(Object.keys(built).sort()).toEqual([...PRE_SUMMARY_TEMPLATE_VARIABLES].sort());
  });
});
