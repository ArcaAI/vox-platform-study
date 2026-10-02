/**
 * TASK-1022 (OD-2, folded in) — the per-turn prompt's appended context blocks are REFERENCE, not
 * dictation.
 *
 * Live replay (gemma-4-e2b, `arcaai-gen-soap-revisit`): turn 1's whole transcript was "Good
 * afternoon. Your reports are back." — and the model copied the `TEST RESULTS:` and
 * `SAME-DAY EARLIER VISIT(S):` blocks the per-turn prompt appended after the transcript into
 * today's sections (labs → Last Visit Complaints, the morning aspirin → Current Medications).
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { dataBlock, liveUserOf, type LiveParts } from './live-compose-expectations';

type BuildLivePromptParts = (
  priorNote: string,
  delta: string,
  notes: string,
  elided?: boolean,
  stablePrefix?: string,
  documentTitle?: string,
  operatingFrame?: string,
  turnContract?: string,
  clientVitals?: string,
  clientPreviousVisits?: string,
  carry?: { sameDayPrequel?: string; testResults?: string },
) => LiveParts;

function promptBuilder(): BuildLivePromptParts {
  const args: unknown[] = new Array(29).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = { get: vi.fn(), set: vi.fn(), setex: vi.fn(), publish: vi.fn(), del: vi.fn() };
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  const internals = service as unknown as { buildLivePromptParts: BuildLivePromptParts };
  return internals.buildLivePromptParts.bind(service);
}

const REFERENCE_RULE =
  "REFERENCE ONLY — the PREVIOUS CASE NOTES SUMMARY, TEST RESULTS and SAME-DAY EARLIER VISIT(S) data sections are reference, not dictation: record from them only what the clinician refers to in the current transcript (or what a section's own SOURCE rule takes from the prior record); do not copy them into today's sections on their own.";

const TURN_1 = 'Good afternoon. Your reports are back.';
const TEST_RESULTS = '- Hemoglobin: 10.2 g/dL (ref 13-17) [L]\n- Fasting glucose: 142 mg/dL [H]';
const PREQUEL = '### Earlier visit today (22:23 IST, status CLOSED_COMPLETE)\nDifferential Diagnosis: Stable angina.';

const build = (clientPreviousVisits?: string, carry?: { sameDayPrequel?: string; testResults?: string }, clientVitals?: string) =>
  promptBuilder()(
    '',
    TURN_1,
    '',
    false,
    'SYSTEM PREFIX',
    'Consultation Note',
    '\n\nFRAME',
    '\n\nCONTRACT',
    clientVitals,
    clientPreviousVisits,
    carry,
  );

describe('TASK-1022 — reference blocks are framed as reference', () => {
  it('states the reference rule ONCE, as an instruction, before the frame and contract', () => {
    const parts = build('PRIOR', { testResults: TEST_RESULTS, sameDayPrequel: PREQUEL });

    expect(parts.instructions.split(REFERENCE_RULE)).toHaveLength(2);
    expect(parts.instructions).toContain(`\n\n${REFERENCE_RULE}\n\nFRAME\n\nCONTRACT`);
    expect(liveUserOf(parts)).toContain(
      `${dataBlock('previous_case_notes_summary', 'PREVIOUS CASE NOTES SUMMARY', 'PRIOR')}\n\n${dataBlock('test_results', 'TEST RESULTS', TEST_RESULTS)}\n\n${dataBlock('same_day_prequel_summary', 'SAME-DAY EARLIER VISIT(S)', PREQUEL)}`,
    );
    // The rule is never inside the data the model is told to treat as data.
    expect(liveUserOf(parts)).not.toContain('REFERENCE ONLY');
  });

  it('frames the replay`s own turn 1 (test results + same-day prequel, no prior case notes)', () => {
    const parts = build(undefined, { testResults: TEST_RESULTS, sameDayPrequel: PREQUEL });

    expect(liveUserOf(parts)).toContain(dataBlock('transcript', 'Transcript so far', TURN_1));
    expect(liveUserOf(parts)).toContain(dataBlock('test_results', 'TEST RESULTS', TEST_RESULTS));
    expect(parts.instructions).toContain(REFERENCE_RULE);
  });

  it('frames the prior case notes alone', () => {
    const parts = build('PRIOR');
    expect(parts.instructions).toContain(REFERENCE_RULE);
    expect(liveUserOf(parts)).toContain(dataBlock('previous_case_notes_summary', 'PREVIOUS CASE NOTES SUMMARY', 'PRIOR'));
  });

  it('leaves Recent Vitals OUTSIDE the reference frame (the VITALS rule governs it) and ahead of the reference blocks', () => {
    const parts = build('PRIOR', undefined, 'BP 128/82 mmHg');

    expect(REFERENCE_RULE).not.toContain('Recent Vitals');
    expect(liveUserOf(parts).indexOf('--- Recent Vitals ---')).toBeLessThan(liveUserOf(parts).indexOf('--- PREVIOUS CASE NOTES SUMMARY ---'));
  });

  it('carries no reference rule when no reference block is present', () => {
    const parts = build(undefined, { sameDayPrequel: '', testResults: '  ' }, 'BP 128/82 mmHg');

    expect(parts.instructions).not.toContain('REFERENCE ONLY');
    expect(parts.instructions).toBe(
      'SYSTEM PREFIX\n\nThis is the first turn of this Consultation Note: report what the transcript in the data sections establishes.\n\nFRAME\n\nCONTRACT',
    );
    expect(liveUserOf(parts)).toBe(
      `${dataBlock('transcript', 'Transcript so far', TURN_1)}\n\n${dataBlock('recent_vitals', 'Recent Vitals', 'BP 128/82 mmHg')}`,
    );
  });
});
