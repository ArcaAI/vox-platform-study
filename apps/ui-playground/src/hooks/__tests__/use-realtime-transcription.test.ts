import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRealtimeTranscription } from '../use-realtime-transcription';

const mockRefs = vi.hoisted(() => ({
    createSession: vi.fn().mockResolvedValue({ sessionId: 'session-test-1234' }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    getWebSocketUrl: vi.fn().mockReturnValue('wss://example.test/ws'),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    sendAudioFrame: vi.fn(),
    sendStop: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    disconnectHandler: null as (() => void) | null,
}));

vi.mock('@arcaai/vox', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@arcaai/vox')>();

    class MockStreamingSessionManager {
        createSession = mockRefs.createSession;
        closeSession = mockRefs.closeSession;
        getWebSocketUrl = mockRefs.getWebSocketUrl;
    }

    class MockSttV2WebSocketClient {
        onTranscript = vi.fn();
        onReconnect = vi.fn();
        onReconnectFailed = vi.fn();
        onWsError = vi.fn();
        onDisconnect = vi.fn((cb: () => void) => {
            mockRefs.disconnectHandler = cb;
        });
        connect = mockRefs.connect;
        disconnect = mockRefs.disconnect.mockImplementation(() => {
            mockRefs.disconnectHandler?.();
        });
        sendAudioFrame = mockRefs.sendAudioFrame;
        sendStop = mockRefs.sendStop;
        isConnected = mockRefs.isConnected;
    }

    return {
        ...actual,
        useArcaStore: vi.fn(),
        StreamingSessionManager: MockStreamingSessionManager,
        SttV2WebSocketClient: MockSttV2WebSocketClient,
    };
});

const mockApiClient = {
    post: vi.fn(),
    delete: vi.fn(),
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

import { useArcaStore } from '@arcaai/vox';

beforeEach(() => {
    vi.clearAllMocks();
    mockRefs.disconnectHandler = null;

    vi.stubGlobal(
        'AudioContext',
        class MockAudioContext {
            state = 'running';
            createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
            createScriptProcessor = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }));
            createGain = vi.fn(() => ({
                connect: vi.fn(),
                disconnect: vi.fn(),
                gain: { value: 0 },
            }));
            close = vi.fn().mockResolvedValue(undefined);
        } as unknown as typeof AudioContext,
    );

    (useArcaStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) => selector({
        apiClient: mockApiClient,
        logger: mockLogger,
    }));
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('useRealtimeTranscription', () => {
    it('should return idle status initially', () => {
        const { result } = renderHook(() => useRealtimeTranscription());
        expect(result.current.status).toBe('idle');
        expect(result.current.isStreaming).toBe(false);
        expect(result.current.sessionId).toBeNull();
        expect(result.current.transcripts).toEqual([]);
        expect(result.current.error).toBeNull();
        expect(result.current.inputStream).toBeNull();
    });

    it('should expose start and stop functions', () => {
        const { result } = renderHook(() => useRealtimeTranscription());
        expect(typeof result.current.start).toBe('function');
        expect(typeof result.current.stop).toBe('function');
        expect(typeof result.current.clearTranscripts).toBe('function');
    });

    it('should expose bytesSent counter', () => {
        const { result } = renderHook(() => useRealtimeTranscription());
        expect(result.current.bytesSent).toBe(0);
    });

    it('should expose reconnectAttempts', () => {
        const { result } = renderHook(() => useRealtimeTranscription());
        expect(result.current.reconnectAttempts).toBe(0);
    });

    it('should throw when SDK is not initialized', async () => {
        (useArcaStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) => selector({
            apiClient: null,
            logger: null,
        }));

        const { result } = renderHook(() => useRealtimeTranscription());

        await act(async () => {
            try {
                await result.current.start({ pipelineId: 'test' });
            } catch (e) {
                expect((e as Error).message).toMatch(/SDK not initialized/);
            }
        });
    });

    it('should clear transcripts', () => {
        const { result } = renderHook(() => useRealtimeTranscription());

        act(() => {
            result.current.clearTranscripts();
        });

        expect(result.current.transcripts).toEqual([]);
    });

    it('should accept pipelineId in start options', () => {
        const { result } = renderHook(() => useRealtimeTranscription());
        expect(typeof result.current.start).toBe('function');
    });

    it('should stay idle when disconnect happens during stop', async () => {
        const { result } = renderHook(() => useRealtimeTranscription());
        const stream = { getTracks: vi.fn(() => []) } as unknown as MediaStream;

        await act(async () => {
            await result.current.start({
                pipelineId: 'pipeline-1',
                stream,
            });
        });

        expect(result.current.status).toBe('streaming');

        await act(async () => {
            await result.current.stop();
        });

        expect(result.current.status).toBe('idle');
        expect(result.current.error).toBeNull();
    });
});
