/**
 * @arcaai/stt - STTProcessor.setLanguage tests
 *
 * Whisper bakes the language into its inference pipeline, so a true language
 * change requires re-initializing the local provider with the new locale.
 * Previously this method only logged a warning and silently kept the old
 * language alive in the engine.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STTProcessor } from '../core/STTProcessor.js';
import { LocalSTTProvider } from '../providers/LocalSTTProvider.js';

describe('STTProcessor.setLanguage', () => {
  let processor: STTProcessor;

  beforeEach(() => {
    processor = new STTProcessor({
      sessionId: 'test-session',
      audio: { language: 'en-US', sampleRate: 16000, channels: 1, chunkLengthS: 30, overlapLengthS: 5 },
      features: { provider: 'local', modelId: 'whisper-tiny' },
    });
  });

  it('updates the stored audio.language for any provider type', async () => {
    // Resolve provider type without going through the heavy init path.
    (processor as unknown as { resolvedProviderType: string }).resolvedProviderType = 'remote';

    await processor.setLanguage('th-TH');

    expect(processor.getOptions().audio?.language).toBe('th-TH');
  });

  it('reinitializes the local provider when the language actually changes', async () => {
    // Simulate an already-initialized local provider.
    const fakeProvider = Object.create(LocalSTTProvider.prototype) as LocalSTTProvider;
    (processor as unknown as { provider: LocalSTTProvider | null }).provider = fakeProvider;
    (processor as unknown as { resolvedProviderType: string }).resolvedProviderType = 'local';

    const initSpy = vi.spyOn(processor as unknown as { initializeLocalProvider(): Promise<void> }, 'initializeLocalProvider').mockResolvedValue();

    await processor.setLanguage('th-TH');

    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(processor.getOptions().audio?.language).toBe('th-TH');
  });

  it('is a no-op when the language matches the current value (no reinit)', async () => {
    const fakeProvider = Object.create(LocalSTTProvider.prototype) as LocalSTTProvider;
    (processor as unknown as { provider: LocalSTTProvider | null }).provider = fakeProvider;
    (processor as unknown as { resolvedProviderType: string }).resolvedProviderType = 'local';

    const initSpy = vi.spyOn(processor as unknown as { initializeLocalProvider(): Promise<void> }, 'initializeLocalProvider').mockResolvedValue();

    await processor.setLanguage('en-US'); // same as initial language

    expect(initSpy).not.toHaveBeenCalled();
  });

  it('does NOT reinitialize when there is no live provider (defer until first init)', async () => {
    (processor as unknown as { resolvedProviderType: string }).resolvedProviderType = 'local';
    (processor as unknown as { provider: null }).provider = null;

    const initSpy = vi.spyOn(processor as unknown as { initializeLocalProvider(): Promise<void> }, 'initializeLocalProvider').mockResolvedValue();

    await processor.setLanguage('th-TH');

    expect(initSpy).not.toHaveBeenCalled();
    expect(processor.getOptions().audio?.language).toBe('th-TH');
  });

  it('does NOT reinitialize the remote provider (language is applied on next session)', async () => {
    (processor as unknown as { resolvedProviderType: string }).resolvedProviderType = 'remote';
    (processor as unknown as { provider: { name: string } }).provider = { name: 'remote-stub' };

    const initSpy = vi.spyOn(processor as unknown as { initializeLocalProvider(): Promise<void> }, 'initializeLocalProvider').mockResolvedValue();

    await processor.setLanguage('th-TH');

    expect(initSpy).not.toHaveBeenCalled();
    expect(processor.getOptions().audio?.language).toBe('th-TH');
  });

  it('wraps reinit errors in an STTError so callers can react', async () => {
    const fakeProvider = Object.create(LocalSTTProvider.prototype) as LocalSTTProvider;
    (processor as unknown as { provider: LocalSTTProvider | null }).provider = fakeProvider;
    (processor as unknown as { resolvedProviderType: string }).resolvedProviderType = 'local';

    vi.spyOn(processor as unknown as { initializeLocalProvider(): Promise<void> }, 'initializeLocalProvider').mockRejectedValue(
      new Error('model load failed'),
    );

    await expect(processor.setLanguage('ja-JP')).rejects.toThrow(/Failed to switch local STT language to "ja-JP"/);
  });
});
