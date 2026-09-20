/**
 * TASK-994 — the ml-en code-switch GGUF rows carry the measured whisper.cpp decode recommendation.
 *
 * Measured 2026-09-20/21 on two independent code-switched recordings (37 + 23 clips), both
 * quantisations and three decode windows: reducing the encoder context from the trained 1500 frames
 * cuts CER by 0.05–0.11 and per-span decode time by 25–35 % on 7 s spans; 768 and 1024 tie on accuracy
 * through the live WS gateway (0.368 vs 0.374) and 768 commits 18 % earlier, so 768 is the realtime
 * choice. `640` (the one tested value that is not a multiple of 256) collapses the decode on the Metal
 * flash-attention build.
 * `maxTokens` must stay uncapped: Malayalam script tokenises to several tokens per character and a
 * 32–64 cap deletes most of a span. Ticket: docs/implementation/TASK-994-* §6.3b.
 *
 * Scope: ONLY the two ml-en rows were measured; the en-medical whisper.cpp rows keep the engine
 * default (no `audioCtx`), so this test also pins that the recommendation did not leak.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_AI_MODELS } from '../06-ai-models';
import { AiModelFormat, ModelTaskType } from '../ai-models/shared';

const ML_EN_GGUF_SLUGS = ['arcaai-whisper-large-ml-en-gguf', 'arcaai-whisper-large-ml-en-gguf-q8_0'] as const;
const MEASURED_AUDIO_CTX = 768;

const whisperCppAsrRows = DEFAULT_AI_MODELS.filter(
  (m) => m.taskType === ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION && m.format === AiModelFormat.WHISPER_CPP,
);
const bySlug = (slug: string) => DEFAULT_AI_MODELS.find((m) => m.slug === slug);

describe('TASK-994 — ml-en GGUF rows carry the measured decode recommendation', () => {
  it.each(ML_EN_GGUF_SLUGS)('%s recommends audioCtx 768', (slug) => {
    const row = bySlug(slug);
    expect(row, `seed row ${slug}`).toBeDefined();
    expect(row!.metaData?.asr?.decoding?.audioCtx, `${slug} decoding.audioCtx`).toBe(MEASURED_AUDIO_CTX);
  });

  it('never caps maxTokens on the ml-en rows (Malayalam needs several tokens per character)', () => {
    for (const slug of ML_EN_GGUF_SLUGS) {
      const maxTokens = bySlug(slug)!.metaData?.asr?.decoding?.maxTokens;
      expect(maxTokens === undefined || maxTokens === 0, `${slug} maxTokens`).toBe(true);
    }
  });

  it('any seeded audioCtx is a multiple of 256 within [512, 1500] (640 collapsed the decode)', () => {
    for (const m of whisperCppAsrRows) {
      const ctx = m.metaData?.asr?.decoding?.audioCtx;
      if (ctx === undefined || ctx === 0) continue;
      expect(ctx % 256, `${m.slug} audioCtx ${ctx} must be a multiple of 256`).toBe(0);
      expect(ctx, `${m.slug} audioCtx`).toBeGreaterThanOrEqual(512);
      expect(ctx, `${m.slug} audioCtx`).toBeLessThanOrEqual(1500);
    }
  });

  it('keeps the unmeasured en-medical whisper.cpp rows at the engine default', () => {
    const others = whisperCppAsrRows.filter((m) => !(ML_EN_GGUF_SLUGS as readonly string[]).includes(m.slug));
    expect(others.length).toBeGreaterThan(0);
    for (const m of others) {
      expect(m.metaData?.asr?.decoding?.audioCtx, `${m.slug} must not carry audioCtx`).toBeUndefined();
    }
  });
});
