/**
 * TASK-891 B1 — the realtime TEXT budget is GOVERNED, not a hard-coded 20 s.
 *
 * ## The defect
 *
 * `LIVE_DOC_TEXT_TIMEOUT_MS` was a raw env read with a hard-coded `?? 20000` fallback and
 * no row anywhere. Measured on `hope-v2-dev` (2026-09-07): one realtime SOAP generation
 * takes 14.06 s on an IDLE cluster with a 136-token transcript, and 20–52 s when Whisper
 * is contending for the same time-sliced GPUs. The budget was below the p50 of the thing
 * it bounded, so the gateway logged `timeout of 20000ms exceeded` on EVERY flush and the
 * case note never rendered.
 *
 * ## What is pinned here
 *
 *  1. the descriptor exists, is `global-kv` / `open-to-default`, and defaults to 60000;
 *  2. an unconfigured deployment sends 60000 on the wire — not 20000;
 *  3. a STORED registry value wins over the env override (the registry is the control
 *     plane; a budget that needs a redeploy to move is the defect being fixed);
 *  4. with no stored value the env override still applies.
 */
import { describe, it, expect, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import {
  CONSULTATION_REALTIME_DEFAULTS,
  CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY,
} from '../../../settings-registry/descriptors/consultation-realtime.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../../../settings-registry/registry';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';

const CID = 'consultation-timeout-001';
const TENANT = 'tenant-timeout-001';
const NOTE = 'Subjective: cough\nObjective:\nAssessment:\nPlan:';

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-07T00:00:00.000Z',
});

function cacheMock() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
}

function buildService(opts: { env?: Record<string, unknown>; storedTimeoutMs?: number } = {}) {
  const post = vi.fn(async (url: string) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate')) return { data: { summary: NOTE } };
    return { data: {} };
  });
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0', ...opts.env };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) => {
      if (key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY) return { value: true, sourceScope: 'tenant' };
      if (key === CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY && opts.storedTimeoutMs !== undefined) {
        return { value: opts.storedTimeoutMs, sourceScope: 'system' };
      }
      return { value: undefined, sourceScope: 'code-default' };
    }),
  };

  const service = new LiveDocumentationService(
    { axiosRef: { post }, post } as never,
    configService as never,
    cacheMock() as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    effectiveSettings as never,
    { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined,
    undefined,
    { findById: vi.fn(async () => ({ id: CID, metadata: null })) } as never,
  );
  return { service, post };
}

/** The `timeout` axios actually received on the `/generate` hop. */
async function generateTimeoutOf(opts: Parameters<typeof buildService>[0]): Promise<number | undefined> {
  const { service, post } = buildService(opts);
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text: 'patient reports a cough', isFinal: true, segmentId: 's1' });
  await service.flush(CID);
  await service.stop(CID, { persistSnapshot: false });

  const call = post.mock.calls.find((c) => String(c[0]).includes('/generate'));
  return (call?.[2] as { timeout?: number } | undefined)?.timeout;
}

describe('TASK-891 B1 — consultation.realtime.textTimeoutMs', () => {
  it('is registered as a governed global-kv tuning knob defaulting to 60000', () => {
    const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY);

    expect(descriptor.tier).toBe('global-kv');
    expect(descriptor.failMode).toBe('open-to-default');
    expect(descriptor.dataType).toBe('number');
    expect(descriptor.default).toBe(60000);
    expect(CONSULTATION_REALTIME_DEFAULTS[CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY]).toBe(60000);
  });

  it('an unconfigured deployment budgets 60000ms, not the old hard-coded 20000ms', async () => {
    expect(await generateTimeoutOf({})).toBe(60000);
  });

  it('a stored registry value wins over the env override', async () => {
    expect(await generateTimeoutOf({ env: { LIVE_DOC_TEXT_TIMEOUT_MS: '25000' }, storedTimeoutMs: 90000 })).toBe(90000);
  });

  it('with no stored value the env override still applies', async () => {
    expect(await generateTimeoutOf({ env: { LIVE_DOC_TEXT_TIMEOUT_MS: '25000' } })).toBe(25000);
  });
});
