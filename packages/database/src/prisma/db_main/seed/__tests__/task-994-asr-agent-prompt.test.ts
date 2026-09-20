/**
 * TASK-994 — the ml-en realtime-transcription agent ships WITHOUT an `initialPrompt`.
 *
 * Measured 2026-09-21 on two independent code-switched Malayalam-English recordings at the served
 * 7 s decode window: the served prompt ("Clinical consultation between a clinician and a patient.
 * English and Malayalam medical terminology.") raised mean CER from 0.390 to 0.680 (37 clips, worse
 * on 32) and from 0.363 to 0.623 (23 clips, worse on 18), deleting about half of every span's text —
 * the same early-stop mechanism TASK-985 §2.7 isolated for the bilingual priming prompt. TASK-985 had
 * measured this prompt as neutral on ENGLISH fixtures only. Ticket README §6.4 / §6.5.
 */
import { describe, expect, it } from 'vitest';

import { ASR_AGENT_SLUG, ASR_PARAMETERS, PLATFORM_AGENT_SPECS } from '../25-agents';

describe('TASK-994 — the ml-en realtime-transcription agent carries no initialPrompt', () => {
  const spec = PLATFORM_AGENT_SPECS.find((s) => s.slug === ASR_AGENT_SLUG);

  it('the seeded agent exists', () => {
    expect(spec, `no PLATFORM_AGENT_SPECS row named '${ASR_AGENT_SLUG}'`).toBeDefined();
  });

  it('its instruction block declares no initialPrompt (prior text makes this fine-tune stop early)', () => {
    const instruction = (spec!.instruction ?? {}) as { initialPrompt?: unknown };
    expect(instruction.initialPrompt, 'instruction.initialPrompt must be absent').toBeUndefined();
  });
});

describe('TASK-994 — the measured live partial geometry of the ml-en agent', () => {
  // S3 (§6.6): the served 3 s / 300 ms partial window fed the semantic endpointer the noisiest
  // hypotheses (65 % garbage partials) and, through the utterance cuts, cost ~0.1 CER on the finals;
  // 7 s / 500 ms and 15 s / 500 ms tied on finals, 7 s committing earlier and reporting a settled
  // prefix more often. 7 s is also the row's decode window, so partial and final geometry coincide.
  it('overrides the partial window to 7 s and the partial cadence to 500 ms', () => {
    expect(ASR_PARAMETERS.streaming.partialWindowSec).toBe(7);
    expect(ASR_PARAMETERS.streaming.partialIntervalMs).toBe(500);
  });

  // S3b: the 50-word previous-final carry-over is prior text in the window too; with it off the
  // eight multi-final clips gained 0.117 CER and commit p95 fell 3072 -> 2677 ms (§6.6).
  it('carries no previous-final text into the next decode (prevTextContextWords 0)', () => {
    expect((ASR_PARAMETERS.decoding as { prevTextContextWords?: number }).prevTextContextWords).toBe(0);
  });
});
