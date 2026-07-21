/**
 * @arcaai/stt - useSTT Hook Integration Tests
 *
 * Integration tests for audio pipeline. Tests processor recreation on
 * config change, and related behavior.
 *
 * Lock-in tests for the `STTProcessor` API surface — `on`/`off`/`destroy`/
 * `releaseWarmResources`/`transcribeSegment`/`setLanguage`.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ProcessorEvent } from '@arcaai/room';
import { useSTT } from '../useSTT.js';

// Track processor instances and their post-A8 method calls for regression
// tests. `eventHandlers` lets a test fire a recorded event back at the hook
// to exercise the data-event reducer in `useSTT`.
type MockProcessor = {
  destroy: ReturnType<typeof vi.fn>;
  getProviderType: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  releaseWarmResources: ReturnType<typeof vi.fn>;
  transcribeSegment: ReturnType<typeof vi.fn>;
  setLanguage: ReturnType<typeof vi.fn>;
  eventHandlers: Map<string, Array<(payload: unknown) => void>>;
};

const processorInstances: MockProcessor[] = [];

vi.mock('../../core/STTProcessor.js', () => ({
  STTProcessor: class MockSTTProcessor {
    destroy = vi.fn().mockResolvedValue(undefined);
    getProviderType = vi.fn().mockReturnValue('remote');
    releaseWarmResources = vi.fn().mockResolvedValue(undefined);
    transcribeSegment = vi.fn().mockResolvedValue({ text: '', isFinal: true, language: 'en' });
    setLanguage = vi.fn().mockResolvedValue(undefined);

    eventHandlers = new Map<string, Array<(payload: any) => void>>();

    on = vi.fn((event: string, handler: (payload: unknown) => void) => {
      const list = this.eventHandlers.get(event) ?? [];
      list.push(handler);
      this.eventHandlers.set(event, list);
    });

    off = vi.fn((event: string, handler: (payload: unknown) => void) => {
      const list = this.eventHandlers.get(event);
      if (!list) return;
      const next = list.filter((h) => h !== handler);
      this.eventHandlers.set(event, next);
    });

    constructor() {
      processorInstances.push(this as unknown as MockProcessor);
    }
  },
}));

function fireEvent(processor: MockProcessor, event: string, payload: unknown): void {
  const handlers = processor.eventHandlers.get(event) ?? [];
  for (const handler of handlers) {
    handler(payload);
  }
}

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

  // Switching the local Whisper task (transcribe<->translate)
  // must rebuild the processor so the new task is baked into the (pooled) local
  // provider; otherwise a translate request silently reuses a transcribe-warm
  // provider. The task therefore belongs in the config fingerprint.
  describe('Processor recreation on task change (TASK-329 P3)', () => {
    it('recreates processor when features.task changes', async () => {
      const { rerender } = renderHook(
        ({ task }: { task: 'transcribe' | 'translate' }) =>
          useSTT({
            track: null,
            autoAttach: false,
            sttSocket: 'wss://test.example.com/ws/stt',
            features: { provider: 'local', modelId: 'whisper-small', task },
          }),
        { initialProps: { task: 'transcribe' as 'transcribe' | 'translate' } },
      );

      await act(async () => { await Promise.resolve(); });
      expect(processorInstances).toHaveLength(1);
      const firstProcessor = processorInstances[0];

      await act(async () => { rerender({ task: 'translate' }); });
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

  // ===========================================================================
  // Lock-in tests for the STTProcessor API surface
  // ===========================================================================

  describe('Post-A8 STTProcessor API alignment (TASK-276)', () => {
    it("subscribes to ProcessorEvent.Data and ProcessorEvent.Error on the processor", async () => {
      renderHook(() =>
        useSTT({
          track: null,
          autoAttach: false,
          sttSocket: 'wss://test.example.com/ws/stt',
          features: { provider: 'remote', modelId: 'whisper-tiny' },
        }),
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(processorInstances).toHaveLength(1);
      const processor = processorInstances[0];

      const subscribedEvents = processor.on.mock.calls.map((call) => call[0]);
      expect(subscribedEvents).toContain(ProcessorEvent.Data);
      expect(subscribedEvents).toContain(ProcessorEvent.Error);
    });

    it('unsubscribes from data + error events when the processor is recreated', async () => {
      const { rerender } = renderHook(
        ({ modelId }) =>
          useSTT({
            track: null,
            autoAttach: false,
            sttSocket: 'wss://test.example.com/ws/stt',
            features: { provider: 'remote', modelId },
          }),
        { initialProps: { modelId: 'whisper-tiny' } },
      );

      await act(async () => {
        await Promise.resolve();
      });
      const first = processorInstances[0];

      await act(async () => {
        rerender({ modelId: 'whisper-base' });
      });
      await act(async () => {
        await Promise.resolve();
      });

      const offEvents = first.off.mock.calls.map((call) => call[0]);
      expect(offEvents).toContain(ProcessorEvent.Data);
      expect(offEvents).toContain(ProcessorEvent.Error);
    });

    it('calls releaseWarmResources after destroy on unmount', async () => {
      const { unmount } = renderHook(() =>
        useSTT({
          track: null,
          autoAttach: false,
          sttSocket: 'wss://test.example.com/ws/stt',
          features: { provider: 'remote', modelId: 'whisper-tiny' },
        }),
      );

      await act(async () => {
        await Promise.resolve();
      });
      const processor = processorInstances[0];

      unmount();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(processor.destroy).toHaveBeenCalled();
      expect(processor.releaseWarmResources).toHaveBeenCalled();
    });

    it('exposes a transcribeSegment that proxies to processor.transcribeSegment', async () => {
      const segmentResult = {
        text: 'hello world',
        isFinal: true,
        language: 'en',
      };

      const { result } = renderHook(() =>
        useSTT({
          track: null,
          autoAttach: false,
          sttSocket: 'wss://test.example.com/ws/stt',
          features: { provider: 'remote', modelId: 'whisper-tiny' },
        }),
      );

      await act(async () => {
        await Promise.resolve();
      });
      const processor = processorInstances[0];
      processor.transcribeSegment.mockResolvedValueOnce(segmentResult);

      const audio = new Float32Array(16);
      let returned: unknown;
      await act(async () => {
        returned = await result.current.transcribeSegment(audio);
      });

      expect(processor.transcribeSegment).toHaveBeenCalledWith(audio);
      expect(returned).toEqual(segmentResult);
      expect(result.current.lastTranscription).toEqual(segmentResult);
      expect(result.current.finalTranscripts).toContainEqual(segmentResult);
    });

    it('forwards setLanguage to the underlying processor', async () => {
      const { result } = renderHook(() =>
        useSTT({
          track: null,
          autoAttach: false,
          sttSocket: 'wss://test.example.com/ws/stt',
          features: { provider: 'remote', modelId: 'whisper-tiny' },
        }),
      );

      await act(async () => {
        await Promise.resolve();
      });
      const processor = processorInstances[0];

      await act(async () => {
        await result.current.setLanguage('fr-FR');
      });

      expect(processor.setLanguage).toHaveBeenCalledWith('fr-FR');
      expect(result.current.language).toBe('fr-FR');
    });

    it('updates final transcripts when processor emits a stt-transcription data event', async () => {
      const { result } = renderHook(() =>
        useSTT({
          track: null,
          autoAttach: false,
          sttSocket: 'wss://test.example.com/ws/stt',
          features: { provider: 'remote', modelId: 'whisper-tiny' },
        }),
      );

      await act(async () => {
        await Promise.resolve();
      });
      const processor = processorInstances[0];

      const finalResult = { text: 'final text', isFinal: true, language: 'en' };
      await act(async () => {
        fireEvent(processor, ProcessorEvent.Data, {
          type: 'stt-transcription',
          data: finalResult,
          timestamp: Date.now(),
        });
      });

      expect(result.current.finalTranscripts).toEqual([finalResult]);
      expect(result.current.lastTranscription).toEqual(finalResult);
      expect(result.current.currentTranscript).toBe('');
    });

    it('updates currentTranscript when processor emits a stt-partial data event', async () => {
      const { result } = renderHook(() =>
        useSTT({
          track: null,
          autoAttach: false,
          sttSocket: 'wss://test.example.com/ws/stt',
          features: { provider: 'remote', modelId: 'whisper-tiny' },
        }),
      );

      await act(async () => {
        await Promise.resolve();
      });
      const processor = processorInstances[0];

      const partial = { text: 'partial text...', isFinal: false, language: 'en' };
      await act(async () => {
        fireEvent(processor, ProcessorEvent.Data, {
          type: 'stt-partial',
          data: partial,
          timestamp: Date.now(),
        });
      });

      expect(result.current.currentTranscript).toBe(partial.text);
      expect(result.current.isProcessing).toBe(true);
    });

    it('updates stats when processor emits a stt-stats data event', async () => {
      const { result } = renderHook(() =>
        useSTT({
          track: null,
          autoAttach: false,
          sttSocket: 'wss://test.example.com/ws/stt',
          features: { provider: 'remote', modelId: 'whisper-tiny' },
        }),
      );

      await act(async () => {
        await Promise.resolve();
      });
      const processor = processorInstances[0];

      const stats = {
        isActive: true,
        isProcessing: false,
        totalAudioProcessed: 10,
        transcriptionCount: 2,
        averageLatencyMs: 120,
        bufferSizeS: 1,
        providerType: 'remote' as const,
        timestamp: Date.now(),
      };

      await act(async () => {
        fireEvent(processor, ProcessorEvent.Data, {
          type: 'stt-stats',
          data: stats,
          timestamp: Date.now(),
        });
      });

      expect(result.current.stats).toEqual(stats);
    });

    it('propagates ProcessorEvent.Error to the error state and onError callback', async () => {
      const onError = vi.fn();
      const { result } = renderHook(() =>
        useSTT({
          track: null,
          autoAttach: false,
          sttSocket: 'wss://test.example.com/ws/stt',
          features: { provider: 'remote', modelId: 'whisper-tiny' },
          onError,
        }),
      );

      await act(async () => {
        await Promise.resolve();
      });
      const processor = processorInstances[0];

      const error = new Error('boom');
      await act(async () => {
        fireEvent(processor, ProcessorEvent.Error, {
          error,
          recoverable: true,
        });
      });

      expect(result.current.error).toBe(error);
      expect(onError).toHaveBeenCalledWith(error);
    });

    it('clear() resets transcripts, current text, and error state', async () => {
      const { result } = renderHook(() =>
        useSTT({
          track: null,
          autoAttach: false,
          sttSocket: 'wss://test.example.com/ws/stt',
          features: { provider: 'remote', modelId: 'whisper-tiny' },
        }),
      );

      await act(async () => {
        await Promise.resolve();
      });
      const processor = processorInstances[0];

      await act(async () => {
        fireEvent(processor, ProcessorEvent.Data, {
          type: 'stt-transcription',
          data: { text: 'one', isFinal: true, language: 'en' },
          timestamp: Date.now(),
        });
        fireEvent(processor, ProcessorEvent.Error, {
          error: new Error('boom'),
          recoverable: true,
        });
      });

      expect(result.current.finalTranscripts).toHaveLength(1);
      expect(result.current.error).not.toBeNull();

      act(() => {
        result.current.clear();
      });

      expect(result.current.finalTranscripts).toHaveLength(0);
      expect(result.current.lastTranscription).toBeNull();
      expect(result.current.currentTranscript).toBe('');
      expect(result.current.error).toBeNull();
    });
  });
});
