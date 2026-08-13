/**
 * useArcaAudio — transcript timestamp is a stream-relative seconds offset.
 *
 * The vox capture path builds `TranscriptSegment.startTime`/`endTime` inside
 * `onTranscription`. Those fields are documented as SECONDS relative to stream
 * start. Previously, when a result carried no VAD/streaming offset, the hook
 * fell back to `Date.now()` (epoch MILLISECONDS), which downstream consumers
 * (the compat playground's `mm:ss.mmm` formatter and the `{timestamp}` text
 * template) rendered as an absurd timestamp. The fallback must be unit-safe (0),
 * and a real `vadStreamStartSec` must pass through unchanged.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { TranscriptionResult } from '../../types';

const roomMocks = vi.hoisted(() => {
  const acquire = vi.fn(async () => ({ sampleRate: 48000 }));
  const getInstance = vi.fn(() => ({ acquire }));
  class MockAudioMixer {
    addSource = vi.fn();
    getMixedTrack = vi.fn(() => ({ kind: 'audio', label: 'mixed-track' }));
    dispose = vi.fn();
  }
  return { getInstance, MockAudioMixer };
});

vi.mock('@arcaai/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/room')>();
  return {
    ...actual,
    AudioMixer: roomMocks.MockAudioMixer,
    AudioContextManager: { getInstance: roomMocks.getInstance },
  };
});

let mockStoreData: Record<string, any>;
vi.mock('../../store', () => ({
  useAgenticStore: vi.fn(() => mockStoreData),
}));

import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';

function makeStream(label: string) {
  const track = { kind: 'audio', label, enabled: true, stop: vi.fn() };
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

function setupStore() {
  mockStoreData = {
    pluginManager: {
      setRuntimeOptions: vi.fn(),
      clearRuntimeOptions: vi.fn(),
      setCallbacks: vi.fn(),
      initialize: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      getStates: vi.fn(() => ({
        noiseFilter: { isActive: false, isSupported: true },
        vad: { isActive: true, isSupported: true },
        stt: { isActive: true, isSupported: true, isProcessing: false },
      })),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      getTranscriptionPipeline: vi.fn(() => null),
      getKnowledgePipeline: vi.fn(() => null),
    },
    consultation: { id: 'cons-1' },
    // apiClient null → onTranscription skips the context POST (isolates the
    // segment-building path we assert on).
    apiClient: null,
    logger: null,
    preferences: {},
    transcriptSegments: [],
    setCurrentTranscript: vi.fn(),
    setAudioLanguage: vi.fn(),
    setIsCapturing: vi.fn(),
    setIsSpeaking: vi.fn(),
    setAudioLevel: vi.fn(),
    setAudioPlugins: vi.fn(),
    setAudioError: vi.fn(),
    setActiveStream: vi.fn(),
    setActiveAudioContext: vi.fn(),
    setSttConnectionState: vi.fn(),
    setActivePipeline: vi.fn(),
    addTranscriptSegment: vi.fn(),
    addContextItem: vi.fn(),
    addEntities: vi.fn(),
    resetAudioDropped: vi.fn(),
    markAudioLost: vi.fn(),
    incrementDroppedFrames: vi.fn(),
  };
  (useAgenticStore as any).mockReturnValue(mockStoreData);
  return mockStoreData;
}

/** Start capture and return the plugin `onTranscription` callback the hook wired. */
async function captureOnTranscription(): Promise<(r: TranscriptionResult) => void> {
  const { result } = renderHook(() => useArcaAudio());
  await act(async () => {
    await result.current.start();
  });
  return mockStoreData.pluginManager.setCallbacks.mock.calls[0][0].onTranscription;
}

beforeEach(() => {
  vi.clearAllMocks();
  setupStore();
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => makeStream('default')) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useArcaAudio — transcript timestamp offset', () => {
  it('passes a streaming vadStreamStartSec/EndSec through to the segment unchanged', async () => {
    const onTranscription = await captureOnTranscription();

    act(() => {
      onTranscription({
        text: 'tendency is good',
        isFinal: true,
        vadStreamStartSec: 40.5,
        vadStreamEndSec: 43.25,
      } as TranscriptionResult);
    });

    const segment = mockStoreData.addTranscriptSegment.mock.calls[0][0];
    expect(segment.startTime).toBe(40.5);
    expect(segment.endTime).toBe(43.25);
  });

  it('falls back to 0 (not an epoch-ms wall clock) when the result carries no offset', async () => {
    const onTranscription = await captureOnTranscription();

    act(() => {
      onTranscription({ text: 'no offset here', isFinal: true } as TranscriptionResult);
    });

    const segment = mockStoreData.addTranscriptSegment.mock.calls[0][0];
    expect(segment.startTime).toBe(0);
    expect(segment.endTime).toBe(0);
    // Guard against the regression directly: a Unix epoch in ms is ~1.7e12, which
    // would render as a nonsense `mm:ss` timestamp. The offset must stay small.
    expect(segment.startTime).toBeLessThan(1_000_000);
  });
});
