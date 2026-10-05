/**
 * TASK-1042 — `audio.start({ workflowSlug })` binds the STT session to a standalone workflow.
 * It reaches the plugin manager, and (C1: mutually exclusive) the open consultation's id is NOT
 * sent alongside it.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@arcaai/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/room')>();
  return { ...actual, AudioContextManager: { getInstance: () => ({ acquire: async () => ({ sampleRate: 48000 }) }) } };
});

let mockStoreData: Record<string, any>;
vi.mock('../../store', () => ({ useAgenticStore: vi.fn(() => mockStoreData) }));

import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';
import { createMockLogger } from '../../__tests__/setup';

function makeStream(label: string) {
  const track = { kind: 'audio', label, enabled: true, stop: vi.fn() };
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

function setupStore(consultation: { id: string } | null) {
  const logger = createMockLogger();
  mockStoreData = {
    pluginManager: {
      setRuntimeOptions: vi.fn(),
      clearRuntimeOptions: vi.fn(),
      setCallbacks: vi.fn(),
      initialize: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      getStates: vi.fn(() => ({
        noiseFilter: { isActive: false, isSupported: false },
        vad: { isActive: false, isSupported: false },
        stt: { isActive: true, isSupported: true, isProcessing: false },
      })),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      getTranscriptionPipeline: vi.fn(() => null),
      getKnowledgePipeline: vi.fn(() => null),
    },
    consultation,
    apiClient: null,
    logger: { child: () => logger },
    preferences: {},
    isCapturing: false,
    isMuted: false,
    audioLevel: 0,
    isSpeaking: false,
    currentTranscript: '',
    transcriptSegments: [],
    audioLanguage: 'en',
    audioPlugins: {
      noiseFilter: { isActive: false, isSupported: false },
      vad: { isActive: false, isSupported: false },
      stt: { isActive: false, isSupported: false, isProcessing: false },
    },
    audioError: null,
    activeStream: null,
    activeAudioContext: null,
    setIsCapturing: vi.fn(),
    setIsMuted: vi.fn(),
    setAudioLevel: vi.fn(),
    setIsSpeaking: vi.fn(),
    setCurrentTranscript: vi.fn(),
    setAudioLanguage: vi.fn(),
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
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => makeStream('default')) } });
});
afterEach(() => vi.unstubAllGlobals());

describe('useArcaAudio.start — workflowSlug (TASK-1042)', () => {
  it('forwards workflowSlug to the plugin manager with no consultationId when none is open', async () => {
    setupStore(null);
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ workflowSlug: 'live-note' });
    });

    const runtime = mockStoreData.pluginManager.setRuntimeOptions.mock.calls[0]![0];
    expect(runtime.workflowSlug).toBe('live-note');
    expect(runtime.consultationId).toBeUndefined();
  });

  it('never sends the open consultation alongside a workflowSlug (mutually exclusive)', async () => {
    setupStore({ id: 'cons-1' });
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ workflowSlug: 'live-note' });
    });

    const runtime = mockStoreData.pluginManager.setRuntimeOptions.mock.calls[0]![0];
    expect(runtime.workflowSlug).toBe('live-note');
    expect(runtime.consultationId).toBeUndefined();
  });

  it('without a workflowSlug the consultation is sent exactly as before', async () => {
    setupStore({ id: 'cons-1' });
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ language: 'en' });
    });

    const runtime = mockStoreData.pluginManager.setRuntimeOptions.mock.calls[0]![0];
    expect(runtime.consultationId).toBe('cons-1');
    expect(runtime.workflowSlug).toBeUndefined();
  });
});
