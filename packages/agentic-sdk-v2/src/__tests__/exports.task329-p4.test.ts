/**
 * SDK Exports Verification — LOCAL voice embedding.
 *
 * TASK-1006 (following TASK-865): the in-browser (WavLM) voice-embedding
 * provider was removed — the browser never runs a model. This pins the
 * absence from the core barrel and that the BACKEND voice provider
 * (`useVoiceEmbedding`) is untouched. See task1006-removed.test.ts for the
 * consolidated removed-surface pins.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

describe('local voice-embedding is removed (core barrel, TASK-1006)', () => {
  it('does not export the LOCAL provider hook or its helpers', async () => {
    const core = await import('../core.js');
    expect(core).not.toHaveProperty('useLocalVoiceEmbedding');
    expect(core).not.toHaveProperty('createLocalVoiceEmbedder');
    expect(core).not.toHaveProperty('isLocalVoiceEmbeddingSupported');
    expect(core).not.toHaveProperty('DEFAULT_LOCAL_VOICE_MODEL_ID');
    expect(core).not.toHaveProperty('LOCAL_VOICE_EMBEDDING_DIM');
    expect(core).not.toHaveProperty('LOCAL_VOICE_SAMPLE_RATE');
    expect(core).not.toHaveProperty('cosineSimilarity');
    expect(core).not.toHaveProperty('bestMatch');
    expect(core).not.toHaveProperty('averageEmbeddings');
    expect(core).not.toHaveProperty('resolveVoiceEnrollmentProvider');
    expect(core).not.toHaveProperty('isVoiceEnrollmentProvider');
    expect(core).not.toHaveProperty('VOICE_ENROLLMENT_PROVIDERS');
    expect(core).not.toHaveProperty('DEFAULT_VOICE_ENROLLMENT_PROVIDER');
    expect(core).not.toHaveProperty('DEFAULT_VOICE_MATCH_THRESHOLD');
  });

  it('keeps the existing backend voice provider intact (not replaced)', async () => {
    const core = await import('../core.js');
    expect(typeof core.useVoiceEmbedding).toBe('function');
    expect(core.VOICE_EMBEDDING_ENDPOINTS.enroll).toBe('/voice-profiles/enroll');
  });
});
