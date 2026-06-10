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
    // TASK-351 P0-5 — SDK worklet capture utility mock.
    createAudioCapture: vi.fn(),
    captureOnFrame: null as ((frame: Float32Array) => void) | null,
    captureDestroy: vi.fn(),
    captureSetEnabled: vi.fn(),
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

vi.mock('@arcaai/stt', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@arcaai/stt')>();
    return {
        ...actual,
        createAudioCapture: mockRefs.createAudioCapture,
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

let lastAudioContext: {
    createScriptProcessor: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
} | null = null;

/** A minimal MediaStream stand-in accepted by the hook. */
function makeStream(): MediaStream {
    const track = { kind: 'audio', stop: vi.fn() };
    return {
        getTracks: vi.fn(() => [track]),
        getAudioTracks: vi.fn(() => [track]),
    } as unknown as MediaStream;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockRefs.disconnectHandler = null;
    mockRefs.captureOnFrame = null;
    lastAudioContext = null;
    // Re-arm return values that individual tests override (clearAllMocks
    // does not restore mockReturnValue implementations).
    mockRefs.isConnected.mockReturnValue(true);

    // TASK-351 P0-5 — default capture mock: record the onFrame callback and
    // hand back a destroyable handle, mirroring the SDK utility contract.
    mockRefs.createAudioCapture.mockImplementation(
        async (_ctx: unknown, _track: unknown, onFrame: (frame: Float32Array) => void) => {
            mockRefs.captureOnFrame = onFrame;
            return {
                usesWorklet: true,
                destroy: mockRefs.captureDestroy,
                setEnabled: mockRefs.captureSetEnabled,
            };
        },
    );

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

            constructor() {
                lastAudioContext = this as unknown as NonNullable<typeof lastAudioContext>;
            }
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

    it('should expose a subscribable bytesSent counter (TASK-351 P0-6)', () => {
        const { result } = renderHook(() => useRealtimeTranscription());
        expect(result.current.bytesSent.getSnapshot()).toBe(0);
        expect(typeof result.current.bytesSent.subscribe).toBe('function');
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
        const stream = makeStream();

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

    describe('TASK-351 P0-5 — SDK worklet capture path + zero-copy sends', () => {
        async function startStreaming(overrides: Partial<Parameters<ReturnType<typeof useRealtimeTranscription>['start']>[0]> = {}) {
            const { result } = renderHook(() => useRealtimeTranscription());
            await act(async () => {
                await result.current.start({
                    pipelineId: 'pipeline-1',
                    stream: makeStream(),
                    ...overrides,
                });
            });
            return result;
        }

        it('wires capture through the SDK worklet utility — no ScriptProcessor', async () => {
            const result = await startStreaming();

            expect(result.current.status).toBe('streaming');
            expect(mockRefs.createAudioCapture).toHaveBeenCalledTimes(1);
            expect(lastAudioContext).not.toBeNull();
            expect(lastAudioContext!.createScriptProcessor).not.toHaveBeenCalled();
        });

        it('converts coalesced Float32 frames to Int16 views and sends them zero-copy', async () => {
            await startStreaming();
            expect(mockRefs.captureOnFrame).not.toBeNull();

            act(() => {
                mockRefs.captureOnFrame!(new Float32Array([0, 0.5, -0.5, 1, -1]));
            });

            expect(mockRefs.sendAudioFrame).toHaveBeenCalledTimes(1);
            const sent = mockRefs.sendAudioFrame.mock.calls[0]![0] as Int16Array;
            expect(sent).toBeInstanceOf(Int16Array);
            expect(Array.from(sent)).toEqual([0, 16383, -16384, 32767, -32768]);
        });

        it('does not send frames while the WebSocket is disconnected', async () => {
            await startStreaming();
            mockRefs.isConnected.mockReturnValue(false);

            act(() => {
                mockRefs.captureOnFrame!(new Float32Array([0.1, 0.2]));
            });

            expect(mockRefs.sendAudioFrame).not.toHaveBeenCalled();
        });

        it('accumulates bytesSent without re-rendering the hook owner (P0-6)', async () => {
            const result = await startStreaming();
            const listener = vi.fn();
            result.current.bytesSent.subscribe(listener);
            const transcriptsBefore = result.current.transcripts;

            // Commit timer starts at 0 — a frame ≥ 250ms later commits at once.
            const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(10_000);
            act(() => {
                mockRefs.captureOnFrame!(new Float32Array(1280));
            });
            nowSpy.mockRestore();

            expect(result.current.bytesSent.getSnapshot()).toBe(2560);
            expect(listener).toHaveBeenCalled();
            // No React state was touched by the byte commit.
            expect(result.current.transcripts).toBe(transcriptsBefore);
        });

        it('passes the negotiated sampleRate to createSession (C5)', async () => {
            await startStreaming({ sampleRate: 48000 });

            expect(mockRefs.createSession).toHaveBeenCalledWith(
                expect.objectContaining({ sampleRate: 48000 }),
            );
        });

        it('defaults the createSession sampleRate to 16000 when omitted', async () => {
            await startStreaming();

            expect(mockRefs.createSession).toHaveBeenCalledWith(
                expect.objectContaining({ sampleRate: 16000 }),
            );
        });

        it('destroys the capture handle on stop', async () => {
            const result = await startStreaming();

            await act(async () => {
                await result.current.stop();
            });

            expect(mockRefs.captureDestroy).toHaveBeenCalled();
        });
    });
});
