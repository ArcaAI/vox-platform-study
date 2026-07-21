/**
 * SDK Exports Verification — LOCAL voice embedding.
 *
 * Pins the new in-browser voice-embedding surface to the package barrels so
 * external consumers (`@arcaai/vox` / `@arcaai/vox/core`) can import the local
 * provider hook, the embedder factory, and the cosine/provider helpers.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

describe('TASK-329 P4 — local voice-embedding exports (core barrel)', () => {
  it('exports the LOCAL provider hook', async () => {
    const core = await import('../core.js');
    expect(typeof core.useLocalVoiceEmbedding).toBe('function');
  });

  it('exports the embedder factory + capability check + model constants', async () => {
    const core = await import('../core.js');
    expect(typeof core.createLocalVoiceEmbedder).toBe('function');
    expect(typeof core.isLocalVoiceEmbeddingSupported).toBe('function');
    expect(core.DEFAULT_LOCAL_VOICE_MODEL_ID).toBe('Xenova/wavlm-base-plus-sv');
    expect(core.LOCAL_VOICE_EMBEDDING_DIM).toBe(512);
    expect(core.LOCAL_VOICE_SAMPLE_RATE).toBe(16_000);
  });

  it('exports the cosine-similarity + provider-selection helpers', async () => {
    const core = await import('../core.js');
    expect(typeof core.cosineSimilarity).toBe('function');
    expect(typeof core.bestMatch).toBe('function');
    expect(typeof core.averageEmbeddings).toBe('function');
    expect(typeof core.resolveVoiceEnrollmentProvider).toBe('function');
    expect(typeof core.isVoiceEnrollmentProvider).toBe('function');
    expect(core.VOICE_ENROLLMENT_PROVIDERS).toEqual(['backend', 'local']);
    expect(core.DEFAULT_VOICE_ENROLLMENT_PROVIDER).toBe('backend');
    expect(typeof core.DEFAULT_VOICE_MATCH_THRESHOLD).toBe('number');
  });

  it('keeps the existing backend voice provider intact (not replaced)', async () => {
    const core = await import('../core.js');
    expect(typeof core.useVoiceEmbedding).toBe('function');
    expect(core.VOICE_EMBEDDING_ENDPOINTS.enroll).toBe('/voice-profile/enroll');
  });
});
