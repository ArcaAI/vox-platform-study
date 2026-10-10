/**
 * TASK-1059 RC-5 — NER entities are published even when there is no note to ground them in.
 *
 * ## The defect
 *
 * `groundEntitiesToNote` returned `[]` whenever the note was empty, so a consultation whose first
 * flushes failed (or simply had not produced a note yet) published `entities: []` on every frame —
 * although NLP had found them (TASK-1058: nlp `entity_count 13` in 36 ms vs flush `entityCount: 0`).
 * The clinician saw no highlights for the whole recording.
 *
 * ## The rule pinned here
 *
 *  - no note yet (or this flush failed) ⇒ the extracted entities are published anchored to the
 *    TRANSCRIPT (their `transcriptSegmentId` / offsets), without note offsets;
 *  - a note exists and the flush succeeded ⇒ grounding against the note is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { LiveSummaryEventDto } from '../dto/live-summary.dto';

const CID = 'consultation-1059-ner';
const TENANT = 'tenant-1059-ner';
const UTTERANCE = 'patient reports a cough for three days';

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

async function flushOnce(options: { graph: boolean; text: 'fails' | 'note-with-cough' }) {
  const cache = cacheMock();
  const at = UTTERANCE.indexOf('cough');
  const post = vi.fn(async (url: string) => {
    if (url.includes('/classify/tokens')) {
      return { data: { entities: [{ text: 'cough', entity_type: 'SIGN_SYMPTOM', score: 0.9, position: { start: at, end: at + 5 } }] } };
    }
    if (url.includes('/generate')) {
      if (options.text === 'fails') throw new Error('Request failed with status code 502');
      return { data: { summary: JSON.stringify({ subjective: { addition: 'Reports a cough for three days.' }, objective: null, assessment: null, plan: null }) } };
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
    { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined,
    undefined,
    { findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, metadata: null, departmentId: null, parentConsultationId: null })) } as never,
  );
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text: UTTERANCE, isFinal: true, segmentId: 's1', startTime: 0, endTime: 2.5, utteranceIndex: 0 } as never);
  const payload = await service.flush(CID);
  await service.stop(CID, { persistSnapshot: false });
  return payload as LiveSummaryEventDto;
}

describe('TASK-1059 RC-5 — entities without a note', () => {
  for (const graph of [true, false]) {
    const lane = graph ? 'graph' : 'legacy';

    it(`${lane}: a failed first flush still publishes the entities NER found, anchored to the transcript`, async () => {
      const payload = await flushOnce({ graph, text: 'fails' });

      expect(payload.runningSummary).toBe('');
      expect(payload.entities.length, 'NER found an entity and the frame carried none').toBeGreaterThan(0);
      const [entity] = payload.entities;
      expect(entity).toMatchObject({ text: 'cough', type: 'SIGN_SYMPTOM', transcriptSegmentId: 'utt-0', transcriptStart: 18, transcriptEnd: 23 });
      // No note ⇒ no note offsets: nothing to highlight against yet, so nothing is invented.
      expect(entity!.start).toBeUndefined();
      expect(entity!.end).toBeUndefined();
    });

    it(`${lane}: once a note exists the entities are grounded against it, as before`, async () => {
      const payload = await flushOnce({ graph, text: 'note-with-cough' });

      expect(payload.runningSummary).toContain('cough');
      const entity = payload.entities.find((candidate) => candidate.text === 'cough');
      expect(entity).toBeDefined();
      expect(entity!.start).toBe(payload.runningSummary.toLowerCase().indexOf('cough'));
    });
  }
});
