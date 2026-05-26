/**
 * @arcaai/stt — TASK-304 Wave 3 hotfix
 *
 * Covers:
 *   • `STTProcessor.setReservedSpeakerId` delegates to the live `LocalSTTProvider`
 *     so `PluginManager.propagateUserPreferenceDelta` can pin a doctor's voice
 *     slot mid-session without rebuilding the provider.
 *   • The method is a no-op when no provider exists, when the resolved provider
 *     type is remote, or when the underlying provider does not expose the hook.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { STTProcessor } from '../core/STTProcessor.js';
import { LocalSTTProvider } from '../providers/LocalSTTProvider.js';

interface ProcessorInternals {
  resolvedProviderType: string;
  provider: unknown;
}

function asInternals(processor: STTProcessor): ProcessorInternals {
  return processor as unknown as ProcessorInternals;
}

describe('STTProcessor.setReservedSpeakerId — TASK-304 Wave 3', () => {
  it('forwards the call to the live LocalSTTProvider when the provider is local', () => {
    const processor = new STTProcessor({
      sessionId: 'test',
      audio: { language: 'en-US' },
      features: { provider: 'local', modelId: 'whisper-tiny' },
    });

    const setReservedSpeakerIdSpy = vi.fn();
    const fakeProvider = Object.create(LocalSTTProvider.prototype) as LocalSTTProvider;
    (fakeProvider as unknown as { setReservedSpeakerId: typeof setReservedSpeakerIdSpy }).setReservedSpeakerId =
      setReservedSpeakerIdSpy;

    const internals = asInternals(processor);
    internals.provider = fakeProvider;
    internals.resolvedProviderType = 'local';

    (processor as unknown as { setReservedSpeakerId(id: string | undefined): void }).setReservedSpeakerId('Dr. Smith');

    expect(setReservedSpeakerIdSpy).toHaveBeenCalledTimes(1);
    expect(setReservedSpeakerIdSpy).toHaveBeenCalledWith('Dr. Smith');
  });

  it('is a no-op when no provider has been initialized', () => {
    const processor = new STTProcessor({
      sessionId: 'test',
      audio: { language: 'en-US' },
      features: { provider: 'local', modelId: 'whisper-tiny' },
    });

    expect(() =>
      (processor as unknown as { setReservedSpeakerId(id: string | undefined): void }).setReservedSpeakerId('Dr. Smith'),
    ).not.toThrow();
  });

  it('is a no-op when the active provider is remote (no diarizer to update)', () => {
    const processor = new STTProcessor({
      sessionId: 'test',
      audio: { language: 'en-US' },
      features: { provider: 'remote' },
      sttSocket: 'wss://example.invalid',
    });

    const setReservedSpeakerIdSpy = vi.fn();
    const fakeProvider = { setReservedSpeakerId: setReservedSpeakerIdSpy } as unknown;

    const internals = asInternals(processor);
    internals.provider = fakeProvider;
    internals.resolvedProviderType = 'remote';

    (processor as unknown as { setReservedSpeakerId(id: string | undefined): void }).setReservedSpeakerId('Dr. Smith');

    // Remote provider has no diarizer; the processor must not even attempt the call.
    expect(setReservedSpeakerIdSpy).not.toHaveBeenCalled();
  });

  it('forwards undefined to clear the reserved speaker', () => {
    const processor = new STTProcessor({
      sessionId: 'test',
      audio: { language: 'en-US' },
      features: { provider: 'local', modelId: 'whisper-tiny' },
    });

    const setReservedSpeakerIdSpy = vi.fn();
    const fakeProvider = Object.create(LocalSTTProvider.prototype) as LocalSTTProvider;
    (fakeProvider as unknown as { setReservedSpeakerId: typeof setReservedSpeakerIdSpy }).setReservedSpeakerId =
      setReservedSpeakerIdSpy;

    const internals = asInternals(processor);
    internals.provider = fakeProvider;
    internals.resolvedProviderType = 'local';

    (processor as unknown as { setReservedSpeakerId(id: string | undefined): void }).setReservedSpeakerId(undefined);

    expect(setReservedSpeakerIdSpy).toHaveBeenCalledWith(undefined);
  });

  it('is safe when the local provider does not expose setReservedSpeakerId', () => {
    const processor = new STTProcessor({
      sessionId: 'test',
      audio: { language: 'en-US' },
      features: { provider: 'local', modelId: 'whisper-tiny' },
    });

    // Provider is a LocalSTTProvider instance but lacks the method (older build).
    const fakeProvider = Object.create(LocalSTTProvider.prototype) as LocalSTTProvider;
    const internals = asInternals(processor);
    internals.provider = fakeProvider;
    internals.resolvedProviderType = 'local';

    expect(() =>
      (processor as unknown as { setReservedSpeakerId(id: string | undefined): void }).setReservedSpeakerId('Dr. Smith'),
    ).not.toThrow();
  });
});
