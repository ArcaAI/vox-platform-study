/**
 * TASK-1022 (wave 2, D-GROUND) — the flush THREADS its grounding input into the turn fold.
 *
 * `turn-contract.grounding.task1022.test.ts` pins the rule; this pins the wiring: the flush hands
 * `applyTurn` the transcript seen so far and the same-day prequel / test results the prompt appended,
 * so a sentence copied from the earlier visit into a CURRENT section (`plan`) never reaches the note,
 * while the same sentence stays once the transcript itself supports it.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';

const CID = 'consultation-grounding-1022';
const TENANT = 'tenant-grounding-1022';

const PREQUEL = `### Earlier visit today (07:48 IST, status CLOSED_COMPLETE)
## General Examination & Vitals
Heart Rate is 88 and regular. Lungs are clear to auscultation bilaterally.

## Plan of Care
Aspirin 81 milligrams daily was planned.`;

const COPIED = 'Aspirin 81 milligrams daily was planned at the earlier visit.';

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-30T00:00:00.000Z',
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

const turn = (body: Record<string, unknown>) => JSON.stringify({ subjective: null, objective: null, assessment: null, plan: null, ...body });

async function flushOnce(transcript: string, withPrequel: boolean) {
  const post = vi.fn(async (url: string) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate')) return { data: { summary: turn({ plan: { addition: COPIED } }) } };
    return { data: {} };
  });
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const service = new LiveDocumentationService(
    { axiosRef: { post }, post } as never,
    { get: vi.fn().mockImplementation((k: string) => env[k]) } as never,
    cacheMock() as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(async () => 'cipher'), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
      ),
    } as never,
    { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined,
    undefined,
    { findById: vi.fn(async () => ({ id: CID, metadata: null })) } as never,
  );
  // The carry context the TASK-1020 start path resolves off the consultation row.
  vi.spyOn(service as unknown as { loadCarryContext: () => Promise<unknown> }, 'loadCarryContext').mockResolvedValue({
    sameDayPrequel: { summary: withPrequel ? PREQUEL : '', hasSameDayPrequel: withPrequel },
    testResults: '',
  });

  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text: transcript, isFinal: true, segmentId: 's1' });
  const payload = await service.flush(CID, { force: true });
  await service.stop(CID, { persistSnapshot: false });
  const plan = payload?.sections?.find((section) => section.title.toLowerCase() === 'plan')?.content ?? '';
  return { plan };
}

describe('TASK-1022 D-GROUND — the flush threads the grounding input into the turn fold', () => {
  it('drops a sentence copied from the same-day earlier visit into the current Plan section', async () => {
    const { plan } = await flushOnce('Good afternoon. Your reports are back.', true);
    expect(plan).toBe('');
  });

  it('keeps it when the transcript itself supports it', async () => {
    const { plan } = await flushOnce('Continue Aspirin 81 milligrams daily.', true);
    expect(plan).toBe(COPIED);
  });

  it('keeps it when there is no same-day earlier visit (nothing to copy from)', async () => {
    const { plan } = await flushOnce('Good afternoon. Your reports are back.', false);
    expect(plan).toBe(COPIED);
  });
});
