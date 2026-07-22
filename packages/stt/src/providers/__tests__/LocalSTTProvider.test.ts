/**
 * @arcaai/stt - LocalSTTProvider voice profile wiring tests
 *
 * Verifies that `LocalProviderConfig.voiceProfile.reservedSpeakerId` flows
 * from `LocalSTTProvider.init(...)` into the `LocalSpeakerDiarizer`
 * constructor so the doctor's voice slot is pinned in the local pipeline.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('LocalSTTProvider — voice profile wiring', () => {
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

/**
 * Late-arriving voice profile.
 *
 * `LocalSTTProvider.setReservedSpeakerId` must forward to the underlying
 * `LocalSpeakerDiarizer`, so `PluginManager.propagateUserPreferenceDelta`
 * (and the playground re-renders) can pin the doctor's slot without a
 * full provider rebuild — provided no profiles have been allocated yet.
 */
describe('LocalSTTProvider — Wave 3 setReservedSpeakerId forwarding', () => {
  let diarizerSetCalls: Array<string | undefined>;
  let constructedDiarizers: number;

  beforeEach(() => {
    diarizerSetCalls = [];
    constructedDiarizers = 0;

    vi.doMock('../LocalSpeakerDiarizer.js', () => {
      class FakeLocalSpeakerDiarizer {
        constructor() {
          constructedDiarizers += 1;
        }
        reset() {
          /* noop */
        }
        assignSpeakerWithFeatures() {
          return null;
        }
        setReservedSpeakerId(id: string | undefined): void {
          diarizerSetCalls.push(id);
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

  it('exposes setReservedSpeakerId that delegates to the internal diarizer', async () => {
    const { LocalSTTProvider } = await import('../LocalSTTProvider.js');

    const provider = new LocalSTTProvider();
    await provider.init(baseConfig() as never);

    expect(typeof (provider as { setReservedSpeakerId?: unknown }).setReservedSpeakerId).toBe('function');

    (provider as unknown as { setReservedSpeakerId(id: string | undefined): void }).setReservedSpeakerId('Dr. Smith');

    expect(diarizerSetCalls).toEqual(['Dr. Smith']);
    // The provider should NOT spin up a new diarizer to push the update.
    expect(constructedDiarizers).toBe(1);
  });

  it('is safe to call before init (no diarizer yet)', async () => {
    const { LocalSTTProvider } = await import('../LocalSTTProvider.js');

    const provider = new LocalSTTProvider();
    // No init() yet — no diarizer constructed.
    expect(() =>
      (provider as unknown as { setReservedSpeakerId(id: string | undefined): void }).setReservedSpeakerId('any'),
    ).not.toThrow();
    expect(diarizerSetCalls).toEqual([]);
  });

  it('forwards undefined to clear the reserved speaker', async () => {
    const { LocalSTTProvider } = await import('../LocalSTTProvider.js');

    const provider = new LocalSTTProvider();
    await provider.init(baseConfig() as never);

    (provider as unknown as { setReservedSpeakerId(id: string | undefined): void }).setReservedSpeakerId(undefined);

    expect(diarizerSetCalls).toEqual([undefined]);
  });
});
