/**
 * TASK-1022 (OD-2, folded in) — the per-turn prompt's appended context blocks are REFERENCE, not
 * dictation.
 *
 * Live replay (gemma-4-e2b, `arcaai-gen-soap-revisit`): turn 1's whole transcript was "Good
 * afternoon. Your reports are back." — and the model copied the `TEST RESULTS:` and
 * `SAME-DAY EARLIER VISIT(S):` blocks that `buildTextUserPrompt` appends after the transcript into
 * today's sections (labs → Last Visit Complaints, the morning aspirin → Current Medications).
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';

type BuildTextUserPrompt = (
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
) => string;

function promptBuilder(): BuildTextUserPrompt {
  const args: unknown[] = new Array(29).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = { get: vi.fn(), set: vi.fn(), setex: vi.fn(), publish: vi.fn(), del: vi.fn() };
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  const internals = service as unknown as { buildTextUserPrompt: BuildTextUserPrompt };
  return internals.buildTextUserPrompt.bind(service);
}

const REFERENCE_RULE =
  "REFERENCE ONLY — the blocks below are reference, not dictation: record from them only what the clinician refers to in the current transcript (or what a section's own SOURCE rule takes from the prior record); do not copy them into today's sections on their own.";

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
  it('states the reference rule ONCE, immediately before the first reference block', () => {
    const text = build('PRIOR', { testResults: TEST_RESULTS, sameDayPrequel: PREQUEL });

    expect(text.split(REFERENCE_RULE)).toHaveLength(2);
    expect(text).toContain(
      `\n\n${REFERENCE_RULE}\n\nPREVIOUS CASE NOTES SUMMARY:\nPRIOR\n\nTEST RESULTS:\n${TEST_RESULTS}\n\nSAME-DAY EARLIER VISIT(S):\n${PREQUEL}\n\nFRAME`,
    );
  });

  it('frames the replay`s own turn 1 (test results + same-day prequel, no prior case notes)', () => {
    const text = build(undefined, { testResults: TEST_RESULTS, sameDayPrequel: PREQUEL });

    expect(text).toContain(`Transcript so far:\n${TURN_1}`);
    expect(text).toContain(`\n\n${REFERENCE_RULE}\n\nTEST RESULTS:\n${TEST_RESULTS}`);
    expect(text.indexOf(REFERENCE_RULE)).toBeGreaterThan(text.indexOf(TURN_1));
  });

  it('frames the prior case notes alone', () => {
    expect(build('PRIOR')).toContain(`\n\n${REFERENCE_RULE}\n\nPREVIOUS CASE NOTES SUMMARY:\nPRIOR`);
  });

  it('leaves Recent Vitals OUTSIDE the reference frame (the VITALS rule governs it) and ahead of the rule', () => {
    const text = build('PRIOR', undefined, 'BP 128/82 mmHg');

    expect(text.indexOf('Recent Vitals:')).toBeLessThan(text.indexOf(REFERENCE_RULE));
  });

  it('is byte-identical to the pre-ticket prompt when no reference block is present', () => {
    const text = build(undefined, { sameDayPrequel: '', testResults: '  ' }, 'BP 128/82 mmHg');

    expect(text).not.toContain('REFERENCE ONLY');
    expect(text).toBe(
      `SYSTEM PREFIX\n\nTranscript so far:\n${TURN_1}\n\nThis is the first turn of this Consultation Note: report what the transcript above establishes.\n\nRecent Vitals:\nBP 128/82 mmHg\n\nFRAME\n\nCONTRACT`,
    );
  });
});
