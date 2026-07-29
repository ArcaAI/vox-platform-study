import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { SttCompatGateway } from '../stt-compat.gateway';

const createSocket = () => {
  const handlers: Record<string, (...args: any[]) => unknown> = {};
  return {
    handlers,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
      handlers[event] = handler;
    }),
    readyState: 1,
    OPEN: 1,
  };
};

const createFrame = (audio: Buffer, metadata: Record<string, unknown> = {}): Buffer => {
  const metadataBytes = Buffer.from(JSON.stringify({ type: 'audio', metadata }));
  const frame = Buffer.alloc(5 + metadataBytes.length + audio.length);
  frame[0] = 1;
  frame.writeUInt32BE(metadataBytes.length, 1);
  metadataBytes.copy(frame, 5);
  audio.copy(frame, 5 + metadataBytes.length);
  return frame;
};

describe('SttCompatGateway', () => {
  it('authenticates legacy key, accepts framed audio, and relays the v1 transcription envelope', async () => {
    const client = createSocket();
    const results = new Subject();
    const apiKeyService = {
      extractApiKeyFromWebSocket: vi.fn().mockReturnValue('legacy-key'),
      authenticateByRawKey: vi.fn().mockResolvedValue({ tenantId: 'tenant-1' }),
    };
    const sessionService = {
      getSessionStatus: vi.fn().mockResolvedValue({ sessionId: 'session-1', status: 'active' }),
    };
    const bridgeService = {
      subscribeToResults: vi.fn().mockReturnValue(results.asObservable()),
      writeAudioFrame: vi.fn().mockResolvedValue(undefined),
      writeControlCommand: vi.fn().mockResolvedValue(undefined),
    };
    const sessionBinding = {
      lookup: vi.fn().mockResolvedValue('tenant-1'),
      lookupSessionMeta: vi.fn().mockResolvedValue({ sampleRate: 44100 }),
    };
    const sessionMetadata = {
      getLanguage: vi.fn().mockResolvedValue('en-US'),
    };
    const gateway = new SttCompatGateway(
      apiKeyService as any,
      sessionService as any,
      bridgeService as any,
      sessionBinding as any,
      sessionMetadata as any,
    );

    await gateway.handleConnection(
      client as any,
      {
        url: '/stt?sessionId=session-1&key=legacy-key',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as any,
    );
    await client.handlers.message(
      createFrame(Buffer.from([1, 2, 3]), {
        device_id: 'mic2',
        role: 'doctor',
        other: 'mic2_chunk131',
      }),
      true,
    );
    results.next({ type: 'transcript', text: 'hello', startTime: 1, endTime: 2, isFinal: true, speakerId: 'Guest-1' });

    expect(apiKeyService.authenticateByRawKey).toHaveBeenCalledWith('legacy-key', '127.0.0.1');
    expect(bridgeService.writeAudioFrame).toHaveBeenCalledWith('session-1', 1, Buffer.from([1, 2, 3]), 44100, 'pcm_s16le', false);
    expect(client.send).toHaveBeenCalledWith(expect.stringContaining('"event":"message"'));
    expect(client.send).toHaveBeenCalledWith(expect.stringContaining('"type":"connected"'));

    const transcription = client.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((payload: { data?: { type?: string } }) => payload.data?.type === 'transcription');

    expect(transcription).toEqual({
      event: 'message',
      data: {
        type: 'transcription',
        text: 'hello',
        speaker_id: 'Guest-1',
        is_final: true,
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/),
        session_id: 'session-1',
        metadata: {
          device_id: 'mic2',
          role: 'doctor',
          other: 'mic2_chunk131',
          detected_language: 'en-US',
        },
        chunk_id: 'mic2_chunk131',
        detected_language: 'en-US',
      },
      sessionId: 'session-1',
    });
  });

  it('rejects a socket when session ownership cannot be proven', async () => {
    const client = createSocket();
    const apiKeyService = {
      extractApiKeyFromWebSocket: vi.fn().mockReturnValue('legacy-key'),
      authenticateByRawKey: vi.fn().mockResolvedValue({ tenantId: 'tenant-1' }),
    };
    const sessionService = { getSessionStatus: vi.fn() };
    const bridgeService = { subscribeToResults: vi.fn() };
    const sessionBinding = { lookup: vi.fn().mockResolvedValue(null) };
    const gateway = new SttCompatGateway(apiKeyService as any, sessionService as any, bridgeService as any, sessionBinding as any);

    await gateway.handleConnection(
      client as any,
      {
        url: '/stt?sessionId=session-1&key=legacy-key',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as any,
    );

    expect(client.close).toHaveBeenCalledWith(4401, 'Authentication failed');
    expect(sessionService.getSessionStatus).not.toHaveBeenCalled();
    expect(bridgeService.subscribeToResults).not.toHaveBeenCalled();
  });
});
