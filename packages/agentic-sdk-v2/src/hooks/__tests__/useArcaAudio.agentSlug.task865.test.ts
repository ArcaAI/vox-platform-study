/**
 * useArcaAudio — `agentSlug` replaces `pipelineId` (TASK-865).
 *
 * The client never names a pipeline, an engine, a model or a VAD. It may name
 * the tenant's ASR AGENT by slug (a lineage key, like `workflowDefinitionSlug`
 * at `session.open()`), or name nothing and let the assignment cascade decide.
 *
 *   * `start({ agentSlug })`  → forwarded to the plugin manager, no pipelineId.
 *   * `start({ pipelineId })` → still forwarded (deprecated path) + ONE warning.
 *   * both                    → `agentSlug` wins, `pipelineId` is DROPPED, and the
 *                               conflict is warned about — never both silently.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@arcaai/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/room')>();
  return {
    ...actual,
    AudioContextManager: { getInstance: () => ({ acquire: async () => ({ sampleRate: 48000 }) }) },
  };
});

let mockStoreData: Record<string, any>;
vi.mock('../../store', () => ({
  useAgenticStore: vi.fn(() => mockStoreData),
}));

import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';
import { createMockLogger } from '../../__tests__/setup';

function makeStream(label: string) {
  const track = { kind: 'audio', label, enabled: true, stop: vi.fn() };
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

function createMockPluginManager() {
  return {
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
  };
}

let logger: ReturnType<typeof createMockLogger>;

function setupStore() {
  logger = createMockLogger();
  mockStoreData = {
    pluginManager: createMockPluginManager(),
    consultation: { id: 'cons-1' },
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
  return mockStoreData;
}

beforeEach(() => {
  vi.clearAllMocks();
  setupStore();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => makeStream('default')) } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function deprecationWarnings() {
  return logger.warn.mock.calls.filter(([message]) => /deprecat/i.test(String(message)));
}

describe('useArcaAudio.start — agentSlug', () => {
  it('forwards agentSlug to the plugin manager and names no pipeline', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ agentSlug: 'clinic-asr' });
    });

    expect(mockStoreData.pluginManager.setRuntimeOptions).toHaveBeenCalledWith(expect.objectContaining({ agentSlug: 'clinic-asr', pipelineId: undefined }));
    expect(deprecationWarnings()).toHaveLength(0);
  });

  it('records the requested agent as the active selection until the gateway echoes the resolved one', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ agentSlug: 'clinic-asr' });
    });

    expect(mockStoreData.setActivePipeline).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'clinic-asr', isFallback: false }));
  });

  it('still forwards a bare pipelineId (deprecated path) and warns once about the deprecation', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ pipelineId: 'legacy-pipe' });
    });

    expect(mockStoreData.pluginManager.setRuntimeOptions).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'legacy-pipe', agentSlug: undefined }));
    expect(deprecationWarnings()).toHaveLength(1);
    expect(String(deprecationWarnings()[0]![0])).toMatch(/agentSlug/);
  });

  it('when BOTH are passed, agentSlug wins and pipelineId is DROPPED — with a warning, never silently', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ agentSlug: 'clinic-asr', pipelineId: 'legacy-pipe' });
    });

    const runtime = mockStoreData.pluginManager.setRuntimeOptions.mock.calls[0]![0];
    expect(runtime.agentSlug).toBe('clinic-asr');
    expect(runtime.pipelineId).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/both/i), expect.objectContaining({ operation: 'startAudio' }));
  });

  it('start() with neither names nothing — the tenant assignment cascade decides server-side', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ language: 'en' });
    });

    const runtime = mockStoreData.pluginManager.setRuntimeOptions.mock.calls[0]![0];
    expect(runtime.agentSlug).toBeUndefined();
    expect(runtime.pipelineId).toBeUndefined();
    expect(deprecationWarnings()).toHaveLength(0);
  });
});
