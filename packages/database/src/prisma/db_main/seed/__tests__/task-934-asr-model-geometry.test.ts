/**
 * TASK-934 lane D — ASR decode-geometry seed invariants (owner go, OD-1/OD-2/OD-5).
 *
 * Static assertions over the EXPORTED seed data (no live DB), following the
 * conventions of `ai-model-registry-seed.test.ts` and `managed-asr-addon-posture.test.ts`
 * in this directory.
 *
 * TASK-934 measured (README §2.2, §4 OD-1/OD-2/OD-5, live proof on the merged build —
 * discharge WER 0.274 -> 0.081):
 *   - a 30s decode window doubles Malayalam-English CER relative to 7s, on both
 *     quantisations of the ml-en fine-tune (0.381 @ 7s vs 0.645 @ 30s) — TASK-891 A5's
 *     `{30, 30}` on the f16 row is reverted;
 *   - lane S decoupled `partialWindowSec` from `maxDecodeWindowSec` (they are independent
 *     knobs, not a matched pair). TASK-934 then set the partial window to 15s on an OFFLINE
 *     fixture measurement (6s = 31% garbage on English, 15s = 0%); TASK-938 (owner
 *     directive 2026-09-09) returns it to 6s after live console sessions on the 15s build
 *     were materially worse, so every whisper.cpp fine-tune row carries
 *     `{ maxDecodeWindowSec: 7, partialWindowSec: 6 }`. The 7s FINAL-decode window is
 *     unchanged — that one was measured on CER directly;
 *   - the platform-default ASR row must BE the row the seeded `realtime-transcription`
 *     agent actually serves, not a row the agent only falls back to. That INVARIANT is what
 *     the tests below assert, so it survives TASK-938 moving the agent back to f16;
 *   - the engine author's VAD default is `minSpeechMs: 100` (a spoken yes/no is
 *     ~150-250ms; at 250ms the whole word was discarded before reaching ASR) — the agent
 *     seed no longer overrides it back up to 250.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_AI_MODELS } from '../06-ai-models';
import { AiModelFormat, AiTaskKind, ModelTaskType } from '../ai-models/shared';
import { ASR_AGENT_SLUG, ASR_PARAMETERS, PLATFORM_AGENT_SPECS } from '../25-agents';

/**
 * The per-model, per-window CER baselines lane M captured on the merged build
 * (`mlen_scorecard_baseline.json`, schema_version 2) — the committed gate the
 * decode-window profile must not silently drift away from. Keyed
 * `<model slug>@<window_s>`.
 */
const SCORECARD_BASELINE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../../../apps/stt/tests/integration/mlen_scorecard_baseline.json', import.meta.url)), 'utf8'),
) as Record<string, { model_slug?: string; window_s?: number } | string>;

const catalog = DEFAULT_AI_MODELS;

const whisperCppAsrRows = catalog.filter(
  (m) => m.taskType === ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION && m.format === AiModelFormat.WHISPER_CPP,
);

describe('TASK-934 — ASR decode-geometry profile (OD-1)', () => {
  it('has at least the four whisper.cpp fine-tune rows this ticket measured', () => {
    expect(whisperCppAsrRows.length).toBeGreaterThanOrEqual(4);
  });

  it('gives every whisper.cpp ASR row the { 7, 6 } decode geometry', () => {
    whisperCppAsrRows.forEach((m) => {
      expect(m.metaData?.asr?.maxDecodeWindowSec, `${m.slug} maxDecodeWindowSec`).toBe(7);
      expect(m.metaData?.asr?.partialWindowSec, `${m.slug} partialWindowSec`).toBe(6);
    });
  });
});

describe('TASK-934 — the platform default IS the seeded agent primary (OD-2)', () => {
  const asrAgent = PLATFORM_AGENT_SPECS.find((spec) => spec.slug === ASR_AGENT_SLUG);

  it('the seeded realtime-transcription agent exists and names a primary model', () => {
    expect(asrAgent, `no PLATFORM_AGENT_SPECS row named '${ASR_AGENT_SLUG}'`).toBeDefined();
    expect(typeof asrAgent!.modelSlug).toBe('string');
  });

  it('exactly one ASR row elects SPEECH_TO_TEXT as its platform default', () => {
    const electedAsrRows = catalog.filter(
      (m) => m.taskType === ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION && (m.isPlatformDefaultFor ?? []).includes(AiTaskKind.SPEECH_TO_TEXT),
    );
    expect(electedAsrRows.map((m) => m.slug)).toHaveLength(1);
  });

  it('the platform-default row is the row the seeded agent serves as primary', () => {
    const electedAsrRows = catalog.filter(
      (m) => m.taskType === ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION && (m.isPlatformDefaultFor ?? []).includes(AiTaskKind.SPEECH_TO_TEXT),
    );
    expect(electedAsrRows[0]?.slug).toBe(asrAgent!.modelSlug);
  });
});

describe('TASK-934 — decode-window profile matches the committed gate baseline', () => {
  const bySlug = (slug: string) => catalog.find((m) => m.slug === slug);

  it("every seeded row named in mlen_scorecard_baseline.json declares that key's window as its maxDecodeWindowSec", () => {
    const entries = Object.entries(SCORECARD_BASELINE).filter(
      (entry): entry is [string, { model_slug: string; window_s: number }] =>
        typeof entry[1] === 'object' && entry[1] !== null && typeof (entry[1] as { model_slug?: unknown }).model_slug === 'string',
    );
    expect(entries.length).toBeGreaterThan(0);

    for (const [key, baseline] of entries) {
      const model = bySlug(baseline.model_slug);
      if (!model) continue; // baseline may outlive a retired row; not this test's concern.
      expect(model.metaData?.asr?.maxDecodeWindowSec, `${key} -> ${baseline.model_slug}.metaData.asr.maxDecodeWindowSec`).toBe(baseline.window_s);
    }
  });
});

describe('TASK-934 — realtime-transcription VAD floor (OD-5)', () => {
  it('no longer re-imposes the retired 250ms minSpeechMs over the engine default of 100ms', () => {
    expect(ASR_PARAMETERS.audioFrontEnd.vad.minSpeechMs).toBe(100);
  });
});
