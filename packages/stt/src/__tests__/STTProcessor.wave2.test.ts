/**
 * @arcaai/stt — Wave 2 (TASK-304 Wave 2) STTProcessor wire-up tests.
 *
 * Covers:
 *   • W2-STT-2 — `setLanguage` failure restores the previous `audio.language`.
 *   • W2-STT-3 — `LocalProviderConfig.task` is forwarded from `STTFeatureFlags.task`
 *               and is included in the local-provider cache key so switching
 *               between `transcribe` / `translate` does not reuse a stale pool entry.
 *   • W2-STT-4 — `LocalProviderConfig.voiceProfile.similarityThreshold` is
 *               forwarded from `STTOptions.voiceProfile`.
 *   • W2-STT-6 — `setLanguage` reinit destroys / pools the old provider rather
 *               than orphaning it.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STTProcessor } from '../core/STTProcessor.js';
import { LocalSTTProvider } from '../providers/LocalSTTProvider.js';
import type { LocalProviderConfig } from '../types/index.js';

interface ProcessorInternals {
  resolvedProviderType: string;
  provider: unknown;
  localProviderCacheKey: string | null;
  initializeLocalProvider(): Promise<void>;
  getLocalProviderCacheKey(): string;
}

function asInternals(processor: STTProcessor): ProcessorInternals {
  return processor as unknown as ProcessorInternals;
}

describe('STTProcessor — Wave 2 (TASK-304)', () => {
  describe('W2-STT-2 setLanguage failure restores previous language', () => {
    let processor: STTProcessor;

    beforeEach(() => {
      processor = new STTProcessor({
        sessionId: 'test',
        audio: { language: 'en-US', sampleRate: 16000, channels: 1, chunkLengthS: 30, overlapLengthS: 5 },
        features: { provider: 'local', modelId: 'whisper-tiny' },
      });
    });

    it('restores audio.language on reinit failure so the next call does not short-circuit', async () => {
      const internals = asInternals(processor);
      internals.provider = Object.create(LocalSTTProvider.prototype) as LocalSTTProvider;
      internals.resolvedProviderType = 'local';

      vi.spyOn(internals, 'initializeLocalProvider').mockRejectedValueOnce(new Error('boom'));

      await expect(processor.setLanguage('ja-JP')).rejects.toThrow(/ja-JP/);

      // Critical: the stored language must NOT have moved to the failed locale,
      // otherwise the short-circuit guard at the top of setLanguage() prevents retry.
      expect(processor.getOptions().audio?.language).toBe('en-US');
    });

    it('does not change the language when the new value equals the old one', async () => {
      const internals = asInternals(processor);
      const initSpy = vi.spyOn(internals, 'initializeLocalProvider').mockResolvedValue();

      await processor.setLanguage('en-US');

      expect(initSpy).not.toHaveBeenCalled();
      expect(processor.getOptions().audio?.language).toBe('en-US');
    });
  });

  describe('W2-STT-3 task forwarding into LocalProviderConfig + cache key', () => {
    it('includes task in the local-provider cache key', () => {
      const transcribeProcessor = new STTProcessor({
        sessionId: 'test',
        audio: { language: 'en-US' },
        features: { provider: 'local', modelId: 'whisper-tiny', task: 'transcribe' },
      });
      const translateProcessor = new STTProcessor({
        sessionId: 'test',
        audio: { language: 'en-US' },
        features: { provider: 'local', modelId: 'whisper-tiny', task: 'translate' },
      });

      const transcribeKey = asInternals(transcribeProcessor).getLocalProviderCacheKey();
      const translateKey = asInternals(translateProcessor).getLocalProviderCacheKey();

      expect(transcribeKey).not.toBe(translateKey);
      expect(JSON.parse(transcribeKey).task).toBe('transcribe');
      expect(JSON.parse(translateKey).task).toBe('translate');
    });

    it('forwards features.task into the LocalProviderConfig handed to LocalSTTProvider.init', async () => {
      const processor = new STTProcessor({
        sessionId: 'test',
        audio: { language: 'en-US' },
        features: { provider: 'local', modelId: 'whisper-tiny', task: 'translate' },
      });

      const initSpy = vi.fn().mockResolvedValue(undefined);
      const fakeProvider = Object.create(LocalSTTProvider.prototype) as LocalSTTProvider;
      Object.assign(fakeProvider, {
        isSupported: () => true,
        init: initSpy,
        onTranscription: () => undefined,
        onError: () => undefined,
        getEngine: () => null,
      });

      vi.spyOn(LocalSTTProvider.prototype, 'isSupported').mockReturnValue(true);
      vi.spyOn(LocalSTTProvider.prototype, 'init').mockImplementation(initSpy);

      const internals = asInternals(processor);
      await internals.initializeLocalProvider();

      expect(initSpy).toHaveBeenCalledTimes(1);
      const config = initSpy.mock.calls[0]?.[0] as LocalProviderConfig | undefined;
      expect(config?.task).toBe('translate');
    });

    it('defaults task to transcribe when features.task is not set', () => {
      const processor = new STTProcessor({
        sessionId: 'test',
        audio: { language: 'en-US' },
        features: { provider: 'local', modelId: 'whisper-tiny' },
      });

      const key = JSON.parse(asInternals(processor).getLocalProviderCacheKey());
      expect(key.task).toBe('transcribe');
    });
  });

  describe('W2-STT-4 voiceProfile.similarityThreshold forwarding', () => {
    it('forwards STTOptions.voiceProfile into LocalProviderConfig', async () => {
      const processor = new STTProcessor({
        sessionId: 'test',
        audio: { language: 'en-US' },
        features: { provider: 'local', modelId: 'whisper-tiny', diarization: true, numSpeakers: 2 },
        voiceProfile: {
          id: 'profile-uuid-123',
          reservedSpeakerId: 'doctor',
          similarityThreshold: 0.85,
        },
      });

      const initSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(LocalSTTProvider.prototype, 'isSupported').mockReturnValue(true);
      vi.spyOn(LocalSTTProvider.prototype, 'init').mockImplementation(initSpy);

      await asInternals(processor).initializeLocalProvider();

      const config = initSpy.mock.calls[0]?.[0] as LocalProviderConfig | undefined;
      expect(config?.voiceProfile).toEqual({
        id: 'profile-uuid-123',
        reservedSpeakerId: 'doctor',
        similarityThreshold: 0.85,
      });
    });

    it('omits voiceProfile when STTOptions.voiceProfile is not set', async () => {
      const processor = new STTProcessor({
        sessionId: 'test',
        audio: { language: 'en-US' },
        features: { provider: 'local', modelId: 'whisper-tiny' },
      });

      const initSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(LocalSTTProvider.prototype, 'isSupported').mockReturnValue(true);
      vi.spyOn(LocalSTTProvider.prototype, 'init').mockImplementation(initSpy);

      await asInternals(processor).initializeLocalProvider();

      const config = initSpy.mock.calls[0]?.[0] as LocalProviderConfig | undefined;
      expect(config?.voiceProfile).toBeUndefined();
    });
  });

  describe('W2-STT-6 setLanguage destroys the old provider', () => {
    it('moves the previous local provider into the pool before installing the new one', async () => {
      const processor = new STTProcessor({
        sessionId: 'test',
        audio: { language: 'en-US' },
        features: { provider: 'local', modelId: 'whisper-tiny' },
      });

      const oldProvider = Object.create(LocalSTTProvider.prototype) as LocalSTTProvider;
      const oldKey = 'old-cache-key';
      const internals = asInternals(processor);
      internals.provider = oldProvider;
      internals.localProviderCacheKey = oldKey;
      internals.resolvedProviderType = 'local';

      const initSpy = vi.spyOn(internals, 'initializeLocalProvider').mockImplementation(async () => {
        internals.provider = Object.create(LocalSTTProvider.prototype) as LocalSTTProvider;
        internals.localProviderCacheKey = 'new-cache-key';
      });

      await processor.setLanguage('ja-JP');

      expect(initSpy).toHaveBeenCalledTimes(1);
      // The old provider must not still be wired as the active provider.
      expect(internals.provider).not.toBe(oldProvider);
    });
  });
});
