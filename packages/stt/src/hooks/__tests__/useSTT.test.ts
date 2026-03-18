/**
 * @arcaai/stt - useSTT Hook Integration Tests
 *
 * TASK-244 Task 3.2: Integration tests for audio pipeline.
 * Tests processor recreation on config change (D2 regression), and related behavior.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSTT } from '../useSTT.js';

// Track processor instances and their destroy calls for D2 regression test
const processorInstances: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];

vi.mock('../../core/STTProcessor.js', () => ({
  STTProcessor: class MockSTTProcessor {
    destroy = vi.fn().mockResolvedValue(undefined);
    getProviderType = vi.fn().mockReturnValue('remote');
    on = vi.fn();
    off = vi.fn();
    releaseWarmResources = vi.fn().mockResolvedValue(undefined);
    setProcessor = vi.fn();
    transcribeSegment = vi.fn().mockResolvedValue({ text: '', isFinal: true, language: 'en' });
    setLanguage = vi.fn().mockResolvedValue(undefined);

    constructor() {
      processorInstances.push(this);
    }
  },
}));

describe('useSTT hook integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processorInstances.length = 0;
  });

  describe('Processor recreation on model change (D2 regression test)', () => {
    it('recreates processor when features.modelId changes', async () => {
      const { rerender } = renderHook(
        ({ modelId }) =>
          useSTT({
            track: null,
            autoAttach: false,
            sttSocket: 'wss://test.example.com/ws/stt',
            features: { provider: 'remote', modelId },
          }),
        { initialProps: { modelId: 'whisper-tiny' } }
      );

      await act(async () => { await Promise.resolve(); });
      expect(processorInstances).toHaveLength(1);
      const firstProcessor = processorInstances[0];

      await act(async () => { rerender({ modelId: 'whisper-base' }); });
      await act(async () => { await Promise.resolve(); });

      expect(processorInstances).toHaveLength(2);
      expect(firstProcessor.destroy).toHaveBeenCalled();
    });
  });

  describe('Processor recreation on language change', () => {
    it('recreates processor when audio.language changes', async () => {
      const { rerender } = renderHook(
        ({ language }: { language: string }) =>
          useSTT({
            track: null,
            autoAttach: false,
            sttSocket: 'wss://test.example.com/ws/stt',
            features: { provider: 'remote', modelId: 'whisper-tiny' },
            audio: { language },
          }),
        { initialProps: { language: 'en-US' } }
      );

      await act(async () => { await Promise.resolve(); });
      expect(processorInstances).toHaveLength(1);
      const firstProcessor = processorInstances[0];

      await act(async () => { rerender({ language: 'hi-IN' }); });
      await act(async () => { await Promise.resolve(); });

      expect(processorInstances).toHaveLength(2);
      expect(firstProcessor.destroy).toHaveBeenCalled();
    });
  });

  describe('Processor recreation on provider change', () => {
    it('recreates processor when features.provider changes', async () => {
      const { rerender } = renderHook(
        ({ provider }: { provider: string }) =>
          useSTT({
            track: null,
            autoAttach: false,
            sttSocket: 'wss://test.example.com/ws/stt',
            features: { provider, modelId: 'whisper-tiny' },
          }),
        { initialProps: { provider: 'remote' } }
      );

      await act(async () => { await Promise.resolve(); });
      expect(processorInstances).toHaveLength(1);
      const firstProcessor = processorInstances[0];

      await act(async () => { rerender({ provider: 'local' }); });
      await act(async () => { await Promise.resolve(); });

      expect(processorInstances).toHaveLength(2);
      expect(firstProcessor.destroy).toHaveBeenCalled();
    });
  });

  describe('Processor stability on irrelevant prop changes', () => {
    it('does NOT recreate processor when non-fingerprint props change', async () => {
      const onTranscription1 = vi.fn();
      const onTranscription2 = vi.fn();

      const { rerender } = renderHook(
        ({ onTranscription }: { onTranscription: () => void }) =>
          useSTT({
            track: null,
            autoAttach: false,
            sttSocket: 'wss://test.example.com/ws/stt',
            features: { provider: 'remote', modelId: 'whisper-tiny' },
            onTranscription,
          }),
        { initialProps: { onTranscription: onTranscription1 } }
      );

      await act(async () => { await Promise.resolve(); });
      expect(processorInstances).toHaveLength(1);

      await act(async () => { rerender({ onTranscription: onTranscription2 }); });
      await act(async () => { await Promise.resolve(); });

      expect(processorInstances).toHaveLength(1);
    });
  });

  describe('Cleanup on unmount', () => {
    it('destroys processor and releases warm resources on unmount', async () => {
      const { unmount } = renderHook(() =>
        useSTT({
          track: null,
          autoAttach: false,
          sttSocket: 'wss://test.example.com/ws/stt',
          features: { provider: 'remote', modelId: 'whisper-tiny' },
        })
      );

      await act(async () => { await Promise.resolve(); });
      expect(processorInstances).toHaveLength(1);
      const processor = processorInstances[0];

      unmount();
      await act(async () => { await Promise.resolve(); });

      expect(processor.destroy).toHaveBeenCalled();
    });
  });
});
