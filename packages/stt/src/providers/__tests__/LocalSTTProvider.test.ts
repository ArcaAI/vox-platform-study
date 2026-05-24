/**
 * @arcaai/stt - LocalSTTProvider TASK-296 C-2 wiring tests
 *
 * Verifies that `LocalProviderConfig.voiceProfile.reservedSpeakerId` flows
 * from `LocalSTTProvider.init(...)` into the `LocalSpeakerDiarizer`
 * constructor so the doctor's voice slot is pinned in the local pipeline.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('LocalSTTProvider — TASK-296 C-2 voice profile wiring', () => {
  let diarizerCtorArgs: Array<Record<string, unknown>>;

  beforeEach(() => {
    diarizerCtorArgs = [];

    vi.doMock('../LocalSpeakerDiarizer.js', () => {
      class FakeLocalSpeakerDiarizer {
        constructor(opts: Record<string, unknown>) {
          diarizerCtorArgs.push(opts);
        }
        reset() {
          /* noop */
        }
        assignSpeakerWithFeatures() {
          return null;
        }
      }
      return { LocalSpeakerDiarizer: FakeLocalSpeakerDiarizer };
    });

    vi.doMock('../../engines/WhisperWorkerEngine.js', () => {
      class FakeWhisperWorkerEngine {
        async init() {
          /* noop */
        }
        async destroy() {
          /* noop */
        }
        async transcribe() {
          return { text: 'ok', isFinal: true, language: 'en' };
        }
        usesWorker() {
          return false;
        }
        getStats() {
          return { isInitialized: true, isTranscribing: false, transcriptionCount: 0, averageLatencyMs: 0 };
        }
      }
      return { WhisperWorkerEngine: FakeWhisperWorkerEngine };
    });
  });

  afterEach(() => {
    vi.doUnmock('../LocalSpeakerDiarizer.js');
    vi.doUnmock('../../engines/WhisperWorkerEngine.js');
    vi.resetModules();
  });

  function baseConfig(extras: Record<string, unknown> = {}) {
    return {
      sessionId: 'session-x',
      modelId: 'tiny',
      language: 'en',
      device: 'wasm' as const,
      quantized: true,
      sampleRate: 16000,
      channels: 1,
      chunkLengthS: 30,
      overlapLengthS: 5,
      returnTimestamps: true,
      diarization: true,
      numSpeakers: 2,
      ...extras,
    };
  }

  it('passes voiceProfile.reservedSpeakerId to LocalSpeakerDiarizer constructor', async () => {
    const { LocalSTTProvider } = await import('../LocalSTTProvider.js');

    const provider = new LocalSTTProvider();
    await provider.init(
      baseConfig({
        voiceProfile: { id: 'profile-uuid-1', reservedSpeakerId: 'Dr. Alice' },
      }) as never,
    );

    expect(diarizerCtorArgs).toHaveLength(1);
    expect(diarizerCtorArgs[0]).toMatchObject({
      enabled: true,
      maxSpeakers: 2,
      reservedSpeakerId: 'Dr. Alice',
    });
  });

  it('omits reservedSpeakerId when voiceProfile is not configured', async () => {
    const { LocalSTTProvider } = await import('../LocalSTTProvider.js');

    const provider = new LocalSTTProvider();
    await provider.init(baseConfig() as never);

    expect(diarizerCtorArgs).toHaveLength(1);
    expect(diarizerCtorArgs[0]).toMatchObject({
      enabled: true,
      maxSpeakers: 2,
    });
    expect(diarizerCtorArgs[0]).not.toHaveProperty('reservedSpeakerId');
  });
});
