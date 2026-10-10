/**
 * TASK-1059 C-0 (owner OD-5 / OD-8 / OD-9) — the live lane judges its narrative CONTEXT before it
 * composes the prompt, and composes only what is in scope.
 *
 * ## What this suite pins
 *
 *  1. the judge receives the narrative items only — transcript chunks, case notes, previous visits —
 *     and never the typed fields (vitals);
 *  2. an out-of-scope item is left out of the prompt TEXT receives; in-scope items are composed;
 *  3. transcript chunks are STABLE across flushes: a sealed chunk (≥ 600 chars) is sent with the same id
 *     and byte-identical text on the next flush, so the judge's digest cache serves it;
 *  4. `refused` (nothing in scope) degrades the document node with the code TEXT's 422
 *     `CONTENT_BLOCKED_NOT_MEDICAL` produced on this lane (`guardrail_blocked`) — without a TEXT call;
 *  5. `ContextJudgeUnavailableError` degrades it as a guardrail outage did (`text_unavailable`) —
 *     without a TEXT call: fail closed, never "in scope".
 */
import { describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { LiveSummaryEventDto } from '../dto/live-summary.dto';
import {
  ContextJudgeUnavailableError,
  type ContextJudgeRequest,
  type ContextJudgeResult,
} from '../../../guardrail-context-judge/IContextMedicalJudgeService';

const CID = 'consultation-1059-judge';
const TENANT = 'tenant-1059-judge';

/** A non-clinical stretch long enough to seal its own chunk. */
const CHATTER = `Where did you park today, the parking lot near the north gate was full again. ${'They are repainting the lines in the parking lot. '.repeat(12)}`.trim();
const CLINICAL = 'patient reports a dry cough for three days with mild fever';

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-10-10T00:00:00.000Z',
});

function cacheMock() {
  const published: unknown[] = [];
  return {
    published,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn(async (_channel: string, raw: string) => {
      published.push(JSON.parse(raw));
    }),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
}

/** A judge that calls anything mentioning parking out of scope. */
function scopeJudge() {
  return vi.fn(async (request: ContextJudgeRequest): Promise<ContextJudgeResult> => {
    const verdicts = request.items.map((item) => ({
      id: item.id,
      digest: `d:${item.text.length}`,
      inScope: !/parking/i.test(item.text),
      contextType: /parking/i.test(item.text) ? 'general' : 'clinical',
      confidence: 0.9,
      cached: false,
    }));
    const inScopeIds = verdicts.filter((v) => v.inScope).map((v) => v.id);
    return {
      verdicts,
      inScopeIds,
      excludedIds: verdicts.filter((v) => !v.inScope).map((v) => v.id),
      refused: verdicts.length > 0 && inScopeIds.length === 0,
    };
  });
}

function buildService(options: { graph: boolean; judge: (request: ContextJudgeRequest) => Promise<ContextJudgeResult>; failFirstText?: boolean }) {
  const cache = cacheMock();
  const prompts: string[] = [];
  let textCalls = 0;
  const post = vi.fn(async (url: string, body: { prompt?: string; system_prompt?: string }) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [] } };
    if (url.includes('/generate')) {
      textCalls += 1;
      prompts.push(`${body?.system_prompt ?? ''}\n${body?.prompt ?? ''}`);
      if (options.failFirstText && textCalls === 1) throw new Error('Request failed with status code 502');
      return { data: { summary: JSON.stringify({ subjective: { addition: 'Dry cough.' }, objective: null, assessment: null, plan: null }) } };
    }
    return { data: {} };
  });
  const service = new LiveDocumentationService(
    { axiosRef: { post }, post } as never,
    { get: vi.fn((k: string) => (k === 'LIVE_DOC_MIN_INTERVAL_MS' ? '0' : undefined)) } as never,
    cache as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: options.graph, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
      ),
    } as never,
    undefined,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined,
    undefined,
    { findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, metadata: null, departmentId: null, parentConsultationId: null })) } as never,
  );
  // The frozen token is injected by Nest in production; set directly here (trailing optional dep).
  (service as unknown as { contextJudge: unknown }).contextJudge = { judge: options.judge };
  return { service, cache, prompts, textCalls: () => textCalls };
}

async function open(service: LiveDocumentationService) {
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  const session = (service as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions.get(CID)!;
  // What the client sent at `open` (vitals are a TYPED field and must never reach the judge).
  session.clientContext = { vitals: 'BP 120/80 VITALS-MARKER', previousVisits: 'Prior visit: hypertension follow-up', raw: { previousVisits: [] } };
  service.handleContextAdded({ consultationId: CID, contextItemId: 'note-1', contextType: 'CASE_NOTE', contentPreview: 'Known type 2 diabetic' } as never);
  service.handleContextAdded({ consultationId: CID, contextItemId: 'note-2', contextType: 'CASE_NOTE', contentPreview: 'Asked about parking validation' } as never);
  service.ingestSegment(CID, { text: CHATTER, isFinal: true, segmentId: 's1' });
  service.ingestSegment(CID, { text: CLINICAL, isFinal: true, segmentId: 's2' });
}

const summaryEvents = (cache: ReturnType<typeof cacheMock>): LiveSummaryEventDto[] =>
  cache.published.filter((p): p is LiveSummaryEventDto => (p as { event?: string }).event === undefined && 'runningSummary' in (p as object));

describe('TASK-1059 C-0 — the live lane composes only in-scope narrative context', () => {
  for (const graph of [true, false]) {
    const lane = graph ? 'graph' : 'legacy';

    it(`${lane}: judges narrative items only, and leaves the out-of-scope ones out of the prompt`, async () => {
      const judge = scopeJudge();
      const { service, prompts } = buildService({ graph, judge });
      await open(service);
      await service.flush(CID);
      await service.stop(CID, { persistSnapshot: false });

      expect(judge).toHaveBeenCalled();
      const request = judge.mock.calls[0]![0];
      expect(request.tenantId).toBe(TENANT);
      expect(request.consultationId).toBe(CID);
      const kinds = request.items.map((item) => `${item.kind}:${item.id}`);
      expect(kinds).toEqual(expect.arrayContaining(['transcript:transcript:0', 'transcript:transcript:1', 'case_note:note-1', 'case_note:note-2', 'prior_visit:previous_visits']));
      expect(request.items.every((item) => !item.text.includes('VITALS-MARKER')), 'a typed field reached the judge').toBe(true);

      const prompt = prompts[0]!;
      expect(prompt).toContain('dry cough');
      expect(prompt).toContain('Known type 2 diabetic');
      expect(prompt).toContain('hypertension follow-up');
      expect(prompt).not.toContain('parking');
    });
  }

  it('sends a sealed transcript chunk with the same id and identical text on the next flush', async () => {
    const judge = scopeJudge();
    // The first TEXT call fails, so the cursor does not advance and the second flush re-reads the backlog.
    const { service } = buildService({ graph: true, judge, failFirstText: true });
    await open(service);
    await service.flush(CID);
    service.ingestSegment(CID, { text: 'and a sore throat since yesterday', isFinal: true, segmentId: 's3' });
    await service.flush(CID);
    await service.stop(CID, { persistSnapshot: false });

    const first = judge.mock.calls[0]![0].items.find((item) => item.id === 'transcript:0');
    const second = judge.mock.calls[1]![0].items.find((item) => item.id === 'transcript:0');
    expect(first).toBeDefined();
    expect(second).toEqual(first);
    // The open chunk is the one that grew.
    const openFirst = judge.mock.calls[0]![0].items.find((item) => item.id === 'transcript:1');
    const openSecond = judge.mock.calls[1]![0].items.find((item) => item.id === 'transcript:1');
    expect(openSecond!.text.startsWith(openFirst!.text)).toBe(true);
    expect(openSecond!.text).toContain('sore throat');
  });

  for (const graph of [true, false]) {
    const lane = graph ? 'graph' : 'legacy';

    it(`${lane}: refused — no TEXT call, the flush degrades as guardrail_blocked`, async () => {
      const judge = vi.fn(
        async (request: ContextJudgeRequest): Promise<ContextJudgeResult> => ({
          verdicts: request.items.map((item) => ({ id: item.id, digest: 'd', inScope: false, contextType: 'general', confidence: 0.9, cached: false })),
          inScopeIds: [],
          excludedIds: request.items.map((item) => item.id),
          refused: true,
        }),
      );
      const { service, cache, textCalls } = buildService({ graph, judge });
      await open(service);
      const payload = await service.flush(CID);
      await service.stop(CID, { persistSnapshot: false });

      expect(textCalls()).toBe(0);
      expect(payload?.flushFailed).toBe(true);
      expect(payload?.degradeReason).toBe('guardrail_blocked');
      expect(summaryEvents(cache).at(-1)?.degradeReason).toBe('guardrail_blocked');
    });

    it(`${lane}: judge unavailable — no TEXT call, the flush degrades as text_unavailable (fail closed)`, async () => {
      const judge = vi.fn(async (): Promise<ContextJudgeResult> => {
        throw new ContextJudgeUnavailableError();
      });
      const { service, textCalls } = buildService({ graph, judge });
      await open(service);
      const payload = await service.flush(CID);
      await service.stop(CID, { persistSnapshot: false });

      expect(textCalls()).toBe(0);
      expect(payload?.flushFailed).toBe(true);
      expect(payload?.degradeReason).toBe('text_unavailable');
    });
  }
});
