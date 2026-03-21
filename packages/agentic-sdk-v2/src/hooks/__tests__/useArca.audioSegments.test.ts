/**
 * useArca Audio Segments & Language Tests (TASK-032 WS-B, Task B-2)
 *
 * Tests that UseArcaAudio exposes:
 * - transcriptSegments: TranscriptSegment[]
 * - language: string
 * And that audio.start() accepts { language?: string, pipelineId?: string }.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArca } from '../useArca';
import type { TranscriptSegment } from '../../types/audio';

const mockStoreDefaults = {
    consultation: null as Record<string, unknown> | null,
    relatedConsultations: [],
    sessionLoading: false,
    sessionError: null,
    isCapturing: false,
    isMuted: false,
    audioLevel: 0,
    isSpeaking: false,
    currentTranscript: '',
    audioPlugins: {
        noiseFilter: { isActive: false, isSupported: false },
        vad: { isActive: false, isSupported: false },
        stt: { isActive: false, isSupported: false, isProcessing: false },
    },
    audioError: null,
    contextItems: [],
    entities: [],
    sharedContext: [],
    contextLoading: false,
    contextError: null,
    summaries: [],
    dnaStyle: null,
    summaryGenerating: false,
    summaryError: null,
    initialized: true,
    globalError: null,
    apiClient: null as Record<string, unknown> | null,
    pluginManager: null as Record<string, unknown> | null,
    logger: null,
    transcriptSegments: [] as TranscriptSegment[],
    audioLanguage: 'en',
    setSessionLoading: vi.fn(),
    setSessionError: vi.fn(),
    setConsultation: vi.fn(),
    clearContext: vi.fn(),
    addContextItem: vi.fn(),
    setRelatedConsultations: vi.fn(),
    setIsCapturing: vi.fn(),
    setIsMuted: vi.fn(),
    setAudioLevel: vi.fn(),
    setIsSpeaking: vi.fn(),
    setCurrentTranscript: vi.fn(),
    setAudioPlugins: vi.fn(),
    setAudioError: vi.fn(),
    setContextLoading: vi.fn(),
    setContextError: vi.fn(),
    updateContextItem: vi.fn(),
    setSharedContext: vi.fn(),
    setEntities: vi.fn(),
    addEntities: vi.fn(),
    setSummaryGenerating: vi.fn(),
    setSummaryError: vi.fn(),
    addSummary: vi.fn(),
    setSummaries: vi.fn(),
    setDNAStyle: vi.fn(),
    setTranscriptSegments: vi.fn(),
    setAudioLanguage: vi.fn(),
    reset: vi.fn(),
};

let currentMockStore = { ...mockStoreDefaults };

vi.mock('../../store', () => {
    return {
        useAgenticStore: vi.fn(() => currentMockStore),
        selectTranscriptions: vi.fn(() => []),
        selectCaseNotes: vi.fn(() => []),
        selectIsAudioSource: vi.fn(() => false),
        selectTranscriptionPipelineState: vi.fn(() => null),
        selectKnowledgePipelineState: vi.fn(() => null),
    };
});

// =============================================================================
// TranscriptSegment type
// =============================================================================

describe('B-2: TranscriptSegment type', () => {
    it('should have required fields: text, startTime, endTime, isFinal', () => {
        const segment: TranscriptSegment = {
            text: 'Hello doctor',
            startTime: 0.0,
            endTime: 1.5,
            isFinal: true,
        };
        expect(segment.text).toBe('Hello doctor');
        expect(segment.startTime).toBe(0.0);
        expect(segment.endTime).toBe(1.5);
        expect(segment.isFinal).toBe(true);
    });

    it('should support optional fields: speakerLabel, confidence, language', () => {
        const segment: TranscriptSegment = {
            text: 'I have a headache',
            startTime: 1.5,
            endTime: 3.0,
            isFinal: true,
            speakerLabel: 'Patient',
            confidence: 0.95,
            language: 'en',
        };
        expect(segment.speakerLabel).toBe('Patient');
        expect(segment.confidence).toBe(0.95);
        expect(segment.language).toBe('en');
    });
});

// =============================================================================
// UseArcaAudio: transcriptSegments and language
// =============================================================================

describe('B-2: UseArcaAudio exposes transcriptSegments and language', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        currentMockStore = {
            ...mockStoreDefaults,
            transcriptSegments: [
                { text: 'Hello', startTime: 0, endTime: 0.5, isFinal: true, speakerLabel: 'Doctor' },
            ],
            audioLanguage: 'nl',
        };
    });

    it('should expose transcriptSegments array from store', () => {
        const { result } = renderHook(() => useArca());
        expect(result.current.audio.transcriptSegments).toEqual([
            { text: 'Hello', startTime: 0, endTime: 0.5, isFinal: true, speakerLabel: 'Doctor' },
        ]);
    });

    it('should expose language string from store', () => {
        const { result } = renderHook(() => useArca());
        expect(result.current.audio.language).toBe('nl');
    });

    it('should default transcriptSegments to empty array', () => {
        currentMockStore = { ...mockStoreDefaults, transcriptSegments: [], audioLanguage: 'en' };
        const { result } = renderHook(() => useArca());
        expect(result.current.audio.transcriptSegments).toEqual([]);
    });

    it('should default language to "en"', () => {
        currentMockStore = { ...mockStoreDefaults, transcriptSegments: [], audioLanguage: 'en' };
        const { result } = renderHook(() => useArca());
        expect(result.current.audio.language).toBe('en');
    });
});

// =============================================================================
// audio.start() with options
// =============================================================================

describe('B-2: audio.start() accepts language and pipelineId options', () => {
    const mockInitialize = vi.fn().mockResolvedValue(undefined);
    const mockSetCallbacks = vi.fn();
    const mockGetStates = vi.fn().mockReturnValue({
        noiseFilter: { isActive: false, isSupported: false },
        vad: { isActive: false, isSupported: false },
        stt: { isActive: false, isSupported: false, isProcessing: false },
    });
    const mockGetKnowledgePipeline = vi.fn().mockReturnValue(null);

    beforeEach(() => {
        vi.clearAllMocks();
        mockInitialize.mockReset().mockResolvedValue(undefined);
        mockSetCallbacks.mockReset();
        mockGetStates.mockReset().mockReturnValue({
            noiseFilter: { isActive: false, isSupported: false },
            vad: { isActive: false, isSupported: false },
            stt: { isActive: false, isSupported: false, isProcessing: false },
        });

        const mockMediaTrack = { label: 'default', kind: 'audio' };
        const mockStream = { getAudioTracks: () => [mockMediaTrack] };

        Object.defineProperty(global, 'navigator', {
            value: {
                mediaDevices: {
                    getUserMedia: vi.fn().mockResolvedValue(mockStream),
                },
            },
            writable: true,
            configurable: true,
        });

        Object.defineProperty(global, 'AudioContext', {
            value: function AudioContext() {
                return { sampleRate: 48000, close: vi.fn() };
            },
            writable: true,
            configurable: true,
        });

        currentMockStore = {
            ...mockStoreDefaults,
            consultation: { id: 'c-001' },
            pluginManager: {
                initialize: mockInitialize,
                setCallbacks: mockSetCallbacks,
                getStates: mockGetStates,
                getKnowledgePipeline: mockGetKnowledgePipeline,
            },
            transcriptSegments: [],
            audioLanguage: 'en',
            setIsCapturing: vi.fn(),
            setAudioPlugins: vi.fn(),
            setAudioError: vi.fn(),
            setAudioLanguage: vi.fn(),
        };
    });

    it('should accept start() with no arguments (backwards compatible)', async () => {
        const { result } = renderHook(() => useArca());

        await act(async () => {
            await result.current.audio.start();
        });

        expect(currentMockStore.setIsCapturing).toHaveBeenCalledWith(true);
    });

    it('should accept start() with language option', async () => {
        const { result } = renderHook(() => useArca());

        await act(async () => {
            await result.current.audio.start({ language: 'nl' });
        });

        expect(currentMockStore.setAudioLanguage).toHaveBeenCalledWith('nl');
    });

    it('should accept start() with pipelineId option', async () => {
        const { result } = renderHook(() => useArca());

        await act(async () => {
            await result.current.audio.start({ pipelineId: 'pipeline-dutch-v2' });
        });

        expect(currentMockStore.setIsCapturing).toHaveBeenCalledWith(true);
    });

    it('should accept start() with both language and pipelineId', async () => {
        const { result } = renderHook(() => useArca());

        await act(async () => {
            await result.current.audio.start({ language: 'fr', pipelineId: 'pipeline-french' });
        });

        expect(currentMockStore.setAudioLanguage).toHaveBeenCalledWith('fr');
        expect(currentMockStore.setIsCapturing).toHaveBeenCalledWith(true);
    });
});
