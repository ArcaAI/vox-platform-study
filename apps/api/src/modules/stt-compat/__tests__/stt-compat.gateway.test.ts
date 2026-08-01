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
    results.next({ type: 'transcript', text: 'without speaker', startTime: 2, endTime: 3, isFinal: true });

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
    const fallbackTranscription = client.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find(
        (payload: { data?: { type?: string; text?: string } }) =>
          payload.data?.type === 'transcription' && payload.data?.text === 'without speaker',
      );
    expect(fallbackTranscription).toMatchObject({
      data: { speaker_id: 'Unknown' },
    });
  });

  it('forwards a provider_switched status frame, passing active and mapping is_fallback → isFallback', async () => {
    const client = createSocket();
    const results = new Subject();
    const apiKeyService = {
      extractApiKeyFromWebSocket: vi.fn().mockReturnValue('legacy-key'),
      authenticateByRawKey: vi.fn().mockResolvedValue({ tenantId: 'tenant-1' }),
    };
    const sessionService = { getSessionStatus: vi.fn().mockResolvedValue({ sessionId: 'session-1', status: 'active' }) };
    const bridgeService = {
      subscribeToResults: vi.fn().mockReturnValue(results.asObservable()),
      writeAudioFrame: vi.fn().mockResolvedValue(undefined),
      writeControlCommand: vi.fn().mockResolvedValue(undefined),
    };
    const sessionBinding = {
      lookup: vi.fn().mockResolvedValue('tenant-1'),
      lookupSessionMeta: vi.fn().mockResolvedValue({ sampleRate: 16000 }),
    };
    const gateway = new SttCompatGateway(apiKeyService as any, sessionService as any, bridgeService as any, sessionBinding as any);

    await gateway.handleConnection(client as any, {
      url: '/stt?sessionId=session-1&key=legacy-key',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as any);
    (client.send as any).mockClear();

    results.next({
      type: 'status',
      status: 'provider_switched',
      from_pipeline: 'azure_speech_transcription',
      to_pipeline: 'sarvam_transcription',
      reason: 'user',
      active: 'fallback',
      is_fallback: '1',
    });

    const status = client.send.mock.calls
      .map((call: unknown[]) => JSON.parse(call[0] as string))
      .find((p: { data?: { status?: string } }) => p.data?.status === 'provider_switched');
    expect(status.data).toMatchObject({
      type: 'status',
      status: 'provider_switched',
      active: 'fallback',
      is_fallback: '1',
      isFallback: true,
      session_id: 'session-1',
    });
  });

  // TASK-597 follow-up #1: the bridge now relays `finalizing` (previously
  // swallowed by its non-terminal allow-list). This gateway needed NO code
  // change — it already default-forwards every status frame — but the v1 wire
  // now carries `finalizing` too, so lock that in.
  it('forwards a finalizing status frame on the v1 wire (default-forward, no allow-list)', async () => {
    const client = createSocket();
    const results = new Subject();
    const apiKeyService = {
      extractApiKeyFromWebSocket: vi.fn().mockReturnValue('legacy-key'),
      authenticateByRawKey: vi.fn().mockResolvedValue({ tenantId: 'tenant-1' }),
    };
    const sessionService = { getSessionStatus: vi.fn().mockResolvedValue({ sessionId: 'session-1', status: 'active' }) };
    const bridgeService = {
      subscribeToResults: vi.fn().mockReturnValue(results.asObservable()),
      writeAudioFrame: vi.fn().mockResolvedValue(undefined),
      writeControlCommand: vi.fn().mockResolvedValue(undefined),
    };
    const sessionBinding = {
      lookup: vi.fn().mockResolvedValue('tenant-1'),
      lookupSessionMeta: vi.fn().mockResolvedValue({ sampleRate: 16000 }),
    };
    const gateway = new SttCompatGateway(apiKeyService as any, sessionService as any, bridgeService as any, sessionBinding as any);

    await gateway.handleConnection(client as any, {
      url: '/stt?sessionId=session-1&key=legacy-key',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as any);
    (client.send as any).mockClear();

    results.next({ type: 'status', status: 'finalizing' });

    const status = client.send.mock.calls
      .map((call: unknown[]) => JSON.parse(call[0] as string))
      .find((p: { data?: { status?: string } }) => p.data?.status === 'finalizing');
    expect(status.data).toMatchObject({
      type: 'status',
      status: 'finalizing',
      session_id: 'session-1',
    });
    expect(status.data.isFallback).toBeUndefined();
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
