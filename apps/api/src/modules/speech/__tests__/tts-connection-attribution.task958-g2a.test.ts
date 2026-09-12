/**
 * TASK-958 G2a — F9/F10 on the TTS billing surface.
 *
 * F9 — `classifyTtsProvider` read `providerOverrides[provider]`, so a tenant whose
 *      candidate resolved a NAMED SIBLING (filed under `provider:slug`) missed its
 *      own entry: its BYOK spend was classified `CLOUD` with no `costBasis` and
 *      landed in platform COGS. The served connection id now selects the entry.
 * F10 — the WS usage frame's `connectionId` was unvalidated, so a non-string could
 *      reach the ledger write.
 */
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyTtsProvider } from '../tts-provider-classification';
import { TtsWsGateway } from '../tts-ws.gateway';

const BYOK = { deployment: 'BYOK', costBasis: 'BYOK_NOTIONAL' };

describe('TASK-958 F9 — the TTS classifier finds a sibling-keyed entry', () => {
  const sibling = { 'azure:azure-research': { api_key: 'k', funding: 'tenant', connection_id: 'conn-2' } };

  it('the SERVED connection id selects the entry, however it is keyed', () => {
    expect(classifyTtsProvider('azure', sibling, 'conn-2')).toMatchObject(BYOK);
  });

  it('a legacy provider-keyed entry is unchanged, with or without an id', () => {
    const legacy = { azure: { api_key: 'k', funding: 'tenant' } };
    expect(classifyTtsProvider('azure', legacy)).toMatchObject(BYOK);
    expect(classifyTtsProvider('azure', legacy, 'conn-1')).toMatchObject(BYOK);
  });

  it('with no id, a single `provider:`-prefixed entry is unambiguous and still classifies as BYOK', () => {
    expect(classifyTtsProvider('azure', sibling)).toMatchObject(BYOK);
  });

  it('with two same-provider entries and no id, the DEFAULT (provider-keyed) entry decides', () => {
    const both = {
      azure: { api_key: 'k', funding: 'platform' },
      'azure:azure-research': { api_key: 'k', funding: 'tenant' },
    };
    expect(classifyTtsProvider('azure', both)).toEqual({ deployment: 'CLOUD' });
  });

  it('two siblings and no default is ambiguous — never guessed', () => {
    const ambiguous = {
      'azure:one': { api_key: 'k', funding: 'tenant' },
      'azure:two': { api_key: 'k', funding: 'tenant' },
    };
    expect(classifyTtsProvider('azure', ambiguous)).toEqual({ deployment: 'CLOUD' });
  });

  it('an entry for a DIFFERENT provider says nothing about this one', () => {
    expect(classifyTtsProvider('azure', { 'sarvam:azure': { api_key: 'k', funding: 'tenant' } })).toEqual({ deployment: 'CLOUD' });
  });
});

// ── the WS lane (F9 call site + F10 guard) ────────────────────────────────────

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

const ticketService = {
  issueTicket: vi.fn(),
  consumeTicket: vi.fn(async () => ({ userId: 'u1', tenantId: 't1', scope: 'tts_session:sess-1', exp: Date.now() + 30_000, impersonatedBy: null })),
};
const config = { getConfigValue: vi.fn((k: string) => (k === 'TTS_URL' ? 'http://tts:8865' : '')) };
const secrets = { getSecretSync: vi.fn(() => 'svc-token') };
const req = () => ({ url: '/ws/tts/stream?sessionId=sess-1&ticket=t' }) as never;

const resolverWith = (overrides: Record<string, unknown>) => ({
  resolve: vi.fn().mockResolvedValue({
    spec: {
      schemaVersion: 1,
      agent: { slug: 'tenant-tts', versionId: 'a1', versionNumber: 1, tenantId: 't1', source: 'tenant' },
      primary: {
        kind: 'primary',
        runtimeKey: 'a1',
        agent: { slug: 'tenant-tts', versionId: 'a1', versionNumber: 1, tenantId: 't1', source: 'tenant' },
        model: {
          role: 'primary',
          slug: 'azure-neural-voices',
          taskType: 'TEXT_TO_SPEECH',
          format: 'AZURE_SPEECH',
          sourceUri: 'azure://neural-voices',
          sourceRevision: null,
          localPath: null,
          checksum: null,
          computeType: null,
          provider: 'azure',
          tenantId: '00000000-0000-0000-0000-000000000000',
          artifacts: {},
          voices: [],
        },
        parameters: { voice: null, language: 'en', speed: null, format: null, sampleRate: null, ssml: false },
        voice: null,
        connection: { provider: 'azure', baseUrl: null, region: 'eastus', timeoutS: null, funding: 'tenant', connectionId: 'conn-2', connectionSlug: 'azure-research' },
        fundingTier: 'tenant',
        connectionKey: 'azure:azure-research',
      },
      fallback: { autoSwitch: true, chain: [] },
    },
    providerOverrides: overrides,
  }),
});

describe('TASK-958 F9/F10 — the WS usage frame', () => {
  let upstream: ReturnType<typeof makeSocket>;
  const usageLedger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o1'], events: 1 }) };

  const open = async (resolver: unknown) => {
    const gateway = new TtsWsGateway(ticketService as never, config as never, secrets as never, resolver as never, usageLedger as never);
    gateway.createUpstreamSocket = vi.fn(() => upstream as never);
    await gateway.handleConnection(makeSocket() as never, req());
    upstream.emit('open');
    return gateway;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    upstream = makeSocket();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  it('a sibling-keyed credential plus the frame`s connectionId meters as the tenant`s own BYOK spend', async () => {
    await open(resolverWith({ 'azure:azure-research': { api_key: 'k', funding: 'tenant', connection_id: 'conn-2' } }));
    upstream.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'usage', characters: 4, audioSeconds: 0.1, interrupted: false, provider: 'azure', connectionId: 'conn-2' })),
      false,
    );
    expect(usageLedger.recordUsage.mock.calls[0][0].common).toMatchObject({ deployment: 'BYOK', costBasis: 'BYOK_NOTIONAL', connectionId: 'conn-2' });
  });

  it('a non-string connectionId never reaches the ledger write', async () => {
    await open(resolverWith({ azure: { api_key: 'k', funding: 'tenant' } }));
    upstream.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'usage', characters: 4, audioSeconds: null, interrupted: false, provider: 'azure', connectionId: { id: 'nope' } })),
      false,
    );
    // The frame is malformed: it is not consumed as a usage frame at all.
    expect(usageLedger.recordUsage).not.toHaveBeenCalled();
  });

  it('an EMPTY connectionId is recorded as no attribution, never as an empty id', async () => {
    await open(resolverWith({ azure: { api_key: 'k', funding: 'tenant' } }));
    upstream.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'usage', characters: 4, audioSeconds: null, interrupted: false, provider: 'azure', connectionId: '' })),
      false,
    );
    expect(usageLedger.recordUsage.mock.calls[0][0].common.connectionId).toBeNull();
  });
});
