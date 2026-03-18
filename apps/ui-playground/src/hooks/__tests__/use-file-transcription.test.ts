import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileTranscription } from '../use-file-transcription';

vi.mock('@arcaai/vox', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@arcaai/vox')>();
    return {
        ...actual,
        useAgenticStore: vi.fn(),
        FileTranscriptionService: vi.fn().mockImplementation(() => ({
            uploadAndTranscribe: vi.fn(),
            buildJobStreamUrl: vi.fn().mockReturnValue('http://localhost:8868/api/v1/audio/transcription-jobs/job-1/stream'),
            dispose: vi.fn(),
        })),
        SSEClient: vi.fn().mockImplementation(() => ({
            connect: vi.fn(),
            disconnect: vi.fn(),
            onOpen: vi.fn(),
            onEvent: vi.fn(),
            onMessage: vi.fn(),
            onError: vi.fn(),
        })),
    };
});

const mockApiClient = {
    postFormData: vi.fn(),
    getBaseUrl: vi.fn().mockReturnValue('http://localhost:8868/api/v1'),
    getAccessToken: vi.fn().mockReturnValue('test-token'),
};

const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
};

import { useAgenticStore } from '@arcaai/vox';

let mockStoreState: { apiClient: typeof mockApiClient | null; logger: typeof mockLogger | null };

beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState = {
        apiClient: mockApiClient,
        logger: mockLogger,
    };
    (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector?: (state: typeof mockStoreState) => unknown) =>
        selector ? selector(mockStoreState) : mockStoreState,
    );
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('useFileTranscription', () => {
    it('should return idle status initially', () => {
        const { result } = renderHook(() => useFileTranscription());
        expect(result.current.status).toBe('idle');
        expect(result.current.isUploading).toBe(false);
        expect(result.current.isStreaming).toBe(false);
        expect(result.current.jobId).toBeNull();
        expect(result.current.transcripts).toEqual([]);
        expect(result.current.error).toBeNull();
        expect(result.current.uploadProgress).toBe(0);
    });

    it('should expose upload and reset functions', () => {
        const { result } = renderHook(() => useFileTranscription());
        expect(typeof result.current.upload).toBe('function');
        expect(typeof result.current.reset).toBe('function');
        expect(typeof result.current.clearTranscripts).toBe('function');
    });

    it('should expose fileName', () => {
        const { result } = renderHook(() => useFileTranscription());
        expect(result.current.fileName).toBeNull();
    });

    it('should throw when SDK is not initialized', async () => {
        mockStoreState = {
            apiClient: null,
            logger: null,
        };

        const { result } = renderHook(() => useFileTranscription());
        const file = new File(['audio'], 'test.wav', { type: 'audio/wav' });

        await act(async () => {
            try {
                await result.current.upload(file, { pipelineId: 'test' });
            } catch (e) {
                expect((e as Error).message).toMatch(/SDK not initialized/);
            }
        });
    });

    it('should clear transcripts', () => {
        const { result } = renderHook(() => useFileTranscription());

        act(() => {
            result.current.clearTranscripts();
        });

        expect(result.current.transcripts).toEqual([]);
    });

    it('should reset all state', () => {
        const { result } = renderHook(() => useFileTranscription());

        act(() => {
            result.current.reset();
        });

        expect(result.current.status).toBe('idle');
        expect(result.current.jobId).toBeNull();
        expect(result.current.transcripts).toEqual([]);
        expect(result.current.uploadProgress).toBe(0);
        expect(result.current.fileName).toBeNull();
    });
});
