/**
 * TASK-1036 §3.2 — the TTS socket's `init` frame accepts `agentSlug`.
 *
 * Absent: today's behaviour — the tenant's assigned TEXT_TO_SPEECH agent, pre-resolved at the
 * handshake. Present on the first `init`: THAT published agent is resolved for the ticket's tenant
 * and its spec is injected instead; frames the client sends meanwhile queue behind it, in order.
 * An agent the tenant cannot use ends the session with a quotable error frame — never a silent
 * fall-back to the assigned agent, which would speak in a voice the caller did not choose.
 */
import { Logger, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TtsWsGateway } from '../tts-ws.gateway';

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
    on: vi.fn((ev: string, cb: Handler) => void (handlers[ev] ||= []).push(cb)),
    emit: (ev: string, ...args: unknown[]) => (handlers[ev] || []).forEach((cb) => cb(...args)),
  };
};

const spec = (slug: string) => ({ agent: { slug }, primary: { parameters: { speed: 1 } } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sent = (socket: ReturnType<typeof makeSocket>) => socket.send.mock.calls.map(([data]) => String(data));

describe('TtsWsGateway — init.agentSlug', () => {
  let gateway: TtsWsGateway;
  let upstream: ReturnType<typeof makeSocket>;
  let resolver: { resolve: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    resolver = {
      resolve: vi.fn(async (input: { agentSlug?: string | null }) => ({
        spec: spec(input.agentSlug ?? 'tenant-default-voice'),
        providerOverrides: {},
      })),
    };
    gateway = new TtsWsGateway(
      { consumeTicket: vi.fn(async () => ({ userId: 'u1', tenantId: 't1', scope: 'tts_session:sess-1', exp: Date.now() + 30_000 })) } as never,
      { getConfigValue: vi.fn(() => 'http://tts:8865') } as never,
      { getSecretSync: vi.fn(() => 'svc') } as never,
      resolver as never,
    );
    upstream = makeSocket();
    gateway.createUpstreamSocket = vi.fn(() => upstream as never);
  });

  it('without agentSlug, injects the tenant-assigned agent (unchanged)', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, { url: '/ws/tts/stream?sessionId=sess-1&ticket=t' } as never);
    upstream.emit('open');
    client.emit('message', Buffer.from('{"type":"init"}'), false);
    expect(JSON.parse(sent(upstream)[0]).resolved_spec.agent.slug).toBe('tenant-default-voice');
  });

  it('with agentSlug, resolves THAT agent for the ticket tenant, strips the slug, and keeps frame order', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, { url: '/ws/tts/stream?sessionId=sess-1&ticket=t' } as never);
    upstream.emit('open');
    client.emit('message', Buffer.from('{"type":"init","agentSlug":"calm-voice"}'), false);
    client.emit('message', Buffer.from('{"type":"text","text":"Hello"}'), false);
    await flush();
    expect(resolver.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: 't1', agentSlug: 'calm-voice' }));
    const frames = sent(upstream).map((frame) => JSON.parse(frame));
    expect(frames[0].type).toBe('init');
    expect(frames[0].resolved_spec.agent.slug).toBe('calm-voice');
    expect(frames[0]).not.toHaveProperty('agentSlug');
    expect(frames[1]).toEqual({ type: 'text', text: 'Hello' });
  });

  it('an agent the tenant cannot use ends the session with an error frame — never the assigned voice', async () => {
    resolver.resolve.mockImplementation(async (input: { agentSlug?: string | null }) => {
      if (input.agentSlug) throw new NotFoundException('Agent not found');
      return { spec: spec('tenant-default-voice'), providerOverrides: {} };
    });
    const client = makeSocket();
    await gateway.handleConnection(client as never, { url: '/ws/tts/stream?sessionId=sess-1&ticket=t' } as never);
    upstream.emit('open');
    client.emit('message', Buffer.from('{"type":"init","agentSlug":"someone-elses"}'), false);
    await flush();
    expect(sent(upstream)).toEqual([]);
    expect(JSON.parse(sent(client)[0])).toMatchObject({ type: 'error', code: 'agent_unavailable' });
    expect(client.close).toHaveBeenCalled();
  });
});
