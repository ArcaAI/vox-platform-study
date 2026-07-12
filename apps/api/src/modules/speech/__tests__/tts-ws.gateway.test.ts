import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TTS_WS_CLOSE_CODES, TtsWsGateway } from '../tts-ws.gateway';

type Handler = (...args: unknown[]) => void;

const makeSocket = () => {
  const handlers: Record<string, Handler[]> = {};
  return {
    readyState: 1,
    OPEN: 1,
    CONNECTING: 0,
    send: vi.fn(),
    close: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    bufferedAmount: 0,
    on: vi.fn((ev: string, cb: Handler) => {
      (handlers[ev] ||= []).push(cb);
    }),
    emit: (ev: string, ...args: unknown[]) => {
      (handlers[ev] || []).forEach((cb) => cb(...args));
    },
  };
};

const createMockTicketService = () => ({
  issueTicket: vi.fn(),
  consumeTicket: vi.fn(async (ticket: string) => {
    if (!ticket || ticket === 'invalid') return null;
    return { userId: 'u1', tenantId: 't1', scope: 'tts_session:sess-1', exp: Date.now() + 30_000, impersonatedBy: null };
  }),
});

const createMockConfig = () => ({
  getConfigValue: vi.fn((k: string) => (k === 'TTS_URL' ? 'http://tts:8865' : '')),
});

const createMockSecrets = () => ({
  getSecretSync: vi.fn((k: string) => (k === 'TTS_SERVICE_TOKEN' ? 'svc-token' : undefined)),
});

const req = (qs: string) => ({ url: `/ws/tts-v2/stream${qs}` }) as never;

describe('TtsWsGateway', () => {
  let gateway: TtsWsGateway;
  let ticketService: ReturnType<typeof createMockTicketService>;
  let config: ReturnType<typeof createMockConfig>;
  let secrets: ReturnType<typeof createMockSecrets>;
  let upstream: ReturnType<typeof makeSocket>;

  beforeEach(() => {
    vi.clearAllMocks();
    ticketService = createMockTicketService();
    config = createMockConfig();
    secrets = createMockSecrets();
    gateway = new TtsWsGateway(ticketService as never, config as never, secrets as never);
    upstream = makeSocket();
    gateway.createUpstreamSocket = vi.fn(() => upstream as never);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  it('rejects a handshake missing sessionId with a generic 4401', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?ticket=t'));
    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, expect.any(String));
    expect(gateway.createUpstreamSocket).not.toHaveBeenCalled();
  });

  it('rejects a handshake missing ticket with a generic 4401', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1'));
    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, expect.any(String));
  });

  it('rejects an invalid ticket with a generic 4401', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=invalid'));
    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, expect.any(String));
    expect(gateway.createUpstreamSocket).not.toHaveBeenCalled();
  });

  it('rejects a scope mismatch with a generic 4401', async () => {
    const client = makeSocket();
    ticketService.consumeTicket.mockResolvedValueOnce({
      userId: 'u1',
      tenantId: 't1',
      scope: 'tts_session:OTHER',
      exp: Date.now() + 30_000,
      impersonatedBy: null,
    } as never);
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, expect.any(String));
  });

  it('opens the upstream at the ws URL with the service token on a valid ticket', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
    expect(gateway.createUpstreamSocket).toHaveBeenCalledWith('ws://tts:8865/api/v1/audio/stream', {
      'X-Service-Token': 'svc-token',
    });
    expect(client.close).not.toHaveBeenCalled();
  });

  it('buffers client control frames until the upstream opens, then flushes them', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
    // Client sends init BEFORE the upstream socket opens.
    client.emit('message', Buffer.from('{"type":"init"}'), false);
    expect(upstream.send).not.toHaveBeenCalled();
    // Upstream opens → buffered frame is flushed.
    upstream.emit('open');
    expect(upstream.send).toHaveBeenCalledWith(Buffer.from('{"type":"init"}'), { binary: false });
    // A later frame forwards live.
    client.emit('message', Buffer.from('{"type":"end"}'), false);
    expect(upstream.send).toHaveBeenCalledWith(Buffer.from('{"type":"end"}'), { binary: false });
  });

  it('relays upstream binary audio frames to the browser verbatim', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
    upstream.emit('open');
    const pcm = Buffer.from([1, 2, 3, 4]);
    upstream.emit('message', pcm, true);
    expect(client.send).toHaveBeenCalledWith(pcm, { binary: true });
  });

  it('closes the upstream when the browser disconnects', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
    gateway.handleDisconnect(client as never);
    expect(upstream.close).toHaveBeenCalled();
  });

  it('closes the browser socket when the upstream errors', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
    upstream.emit('error', new Error('upstream boom'));
    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.UPSTREAM_ERROR);
  });
});
