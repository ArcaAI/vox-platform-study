/**
 * useArcaAudio — canonical speaker-label consolidation.
 *
 * The vox capture path builds `TranscriptSegment.speakerLabel` from the STT
 * result inside `onTranscription`. It previously copied the RAW diarizer
 * `speakerId` verbatim, so the `"unknown"` no-confident-match sentinel reached
 * the clinician as literal "unknown". It must instead apply the SAME semantics as
 * the streaming bridge's canonical `deriveSpeakerLabel` (@arcaai/applications):
 * `"unknown"` → "Unknown speaker"; anonymous `"Speaker N"` ids pass through;
 * empty/missing → no label. It must never fabricate a clinician/patient name.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { TranscriptionResult } from '../../types';

// ---------------------------------------------------------------------------
// Hoisted mocks for @arcaai/room so start() can acquire an audio context
// without real Web Audio, matching the other useArcaAudio suites.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

describe('useArcaAudio — canonical speaker-label', () => {
  it('maps the "unknown" diarizer sentinel to "Unknown speaker" (not the raw id)', async () => {
    const onTranscription = await captureOnTranscription();

    act(() => {
      onTranscription({ text: 'chest pain since this morning', isFinal: true, speakerId: 'unknown' });
    });

    expect(mockStoreData.addTranscriptSegment).toHaveBeenCalledWith(
      expect.objectContaining({ speakerLabel: 'Unknown speaker' }),
    );
    // The raw sentinel must NEVER reach the clinician verbatim.
    const segment = mockStoreData.addTranscriptSegment.mock.calls[0][0];
    expect(segment.speakerLabel).not.toBe('unknown');
  });

  it('passes an anonymous "Speaker N" id through verbatim', async () => {
    const onTranscription = await captureOnTranscription();

    act(() => {
      onTranscription({ text: 'and how long has that been going on?', isFinal: true, speakerId: 'Speaker 1' });
    });

    expect(mockStoreData.addTranscriptSegment).toHaveBeenCalledWith(
      expect.objectContaining({ speakerLabel: 'Speaker 1' }),
    );
  });

  it('leaves speakerLabel undefined when the result carries no speaker attribution', async () => {
    const onTranscription = await captureOnTranscription();

    act(() => {
      onTranscription({ text: 'partial hypothesis', isFinal: true, speakerId: undefined });
    });

    const segment = mockStoreData.addTranscriptSegment.mock.calls[0][0];
    expect(segment.speakerLabel).toBeUndefined();
  });
});
