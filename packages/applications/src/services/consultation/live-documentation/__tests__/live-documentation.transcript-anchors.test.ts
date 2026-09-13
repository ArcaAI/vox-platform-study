/**
 * A2 — a live entity says WHERE IT WAS SAID, not only where it was written.
 *
 * ## The defect
 *
 * NER runs over the transcript delta and returns offsets into it. `groundEntitiesToNote` then
 * re-locates each entity inside the rendered note and OVERWRITES `start`/`end` with note offsets —
 * correct for the highlight overlay, and the end of the transcript address. The published payload
 * therefore had no way to answer "jump to where the patient said this": a console could only match
 * the entity text against the transcript itself and hope the first hit was the right one.
 *
 * ## What this file pins
 *
 *  1. The raw offsets SURVIVE grounding, under `transcriptStart`/`transcriptEnd`.
 *  2. They are rebased onto the UTTERANCE, not left indexing the per-flush delta (which no
 *     consumer ever receives) — so `segment.text.slice(transcriptStart, transcriptEnd)` is the
 *     entity, for the segment `transcriptSegmentId` names.
 *  3. Both engines do it. The legacy flush and the graph lane reach the same NER executor, so an
 *     anchor that worked on one and not the other would be a trap rather than a feature.
 *  4. An entity with no timed utterance behind it carries NO anchor — all three fields absent,
 *     never a fabricated `utt-0` or a delta offset left in place.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';

const ARCAAI = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-anchors';
const STT_SESSION = 'stt-session-anchors';

/** The two utterances every case below speaks, and the delta they join into. */
const UTT_0 = 'cough since monday';
const UTT_1 = 'takes aspirin daily';
const DELTA = `${UTT_0} ${UTT_1}`;

/**
 * A turn that carries both utterances' words into the note.
 *
 * It has to: `groundEntitiesToNote` DROPS an entity whose surface form does not survive in the
 * rendered note, so a turn that echoed neither would make every assertion below vacuously pass on
 * an empty entity list.
 */
const TURN = JSON.stringify({ subjective: { addition: `Cough since monday.` }, plan: { addition: `Takes aspirin daily.` } });

/** The NLP wire shape (`apps/nlp` `schemas/common.py` Entity) — offsets index the DELTA. */
const nlpEntity = (text: string, type: string, start: number) => ({
  text,
  entity_type: type,
  confidence: 0.9,
  position: { start, end: start + text.length },
});

type TranscriptFrame = Record<string, unknown>;

function resultStream() {
  const listeners: Array<(msg: TranscriptFrame) => void> = [];
  return {
    emit(msg: TranscriptFrame) {
      for (const next of [...listeners]) next(msg);
    },
    bridge: {
      subscribeToResults: vi.fn(() => ({
        subscribe: (handlers: { next: (msg: TranscriptFrame) => void }) => {
          listeners.push(handlers.next);
          return { unsubscribe: vi.fn() };
        },
      })),
    },
  };
}

const frame = (over: Partial<TranscriptFrame> & { text: string; startTime: number; endTime: number }): TranscriptFrame => ({
  type: 'transcript',
  isFinal: true,
  ...over,
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

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-13T00:00:00.000Z',
});

/** `graphMode` picks the ENGINE: the tenant-graph realtime lane, or the legacy single-call flush. */
function buildService(opts: { graphMode: boolean; entities: (sourceText: string) => ReturnType<typeof nlpEntity>[] }) {
  const nerCalls: string[] = [];
  const post = vi.fn().mockImplementation((url: string, body: Record<string, unknown>) => {
    if (url.includes('/classify/tokens')) {
      const sourceText = String(body.text);
      nerCalls.push(sourceText);
      return Promise.resolve({ data: { entities: opts.entities(sourceText), vitals: {} } });
    }
    if (url.includes('/generate')) return Promise.resolve({ data: { summary: TURN } });
    return Promise.resolve({ data: {} });
  });
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_DURABLE_SNAPSHOT_MS: '0' };
  const stream = resultStream();

  const service = new LiveDocumentationService(
    { axiosRef: { post } } as never,
    { get: vi.fn().mockImplementation((k: string) => env[k]) } as never,
    cacheMock() as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    stream.bridge as never,
    undefined, // contextItemRepository
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined, // trajectoryService
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY
          ? { value: opts.graphMode, sourceScope: 'tenant' }
          : { value: undefined, sourceScope: 'code-default' },
      ),
    } as never,
    { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined, // textRequestEnrichment
    undefined, // documentTemplateService
    { findById: vi.fn(async (id: string) => ({ id, tenantId: ARCAAI, metadata: null })) } as never,
    { resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: null, source: 'platform-default' })) } as never,
    { findPublishedBySlug: vi.fn(async () => null) } as never,
  );

  return { service, stream, nerCalls };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Speak both utterances, flush once, hand back the published payload. */
async function speakAndFlush(service: LiveDocumentationService, stream: ReturnType<typeof resultStream>) {
  service.start({ consultationId: CID, tenantId: ARCAAI, sessionId: STT_SESSION });
  await settle();
  stream.emit(frame({ text: UTT_0, startTime: 0, endTime: 2, utteranceIndex: 0 }));
  stream.emit(frame({ text: UTT_1, startTime: 2.5, endTime: 4, utteranceIndex: 1 }));
  const payload = await service.flush(CID);
  await service.stop(CID, { persistSnapshot: false });
  return payload;
}

// The offsets the NLP service would report for this delta — computed, not typed in, so the
// fixture cannot drift from the string it describes.
const ASPIRIN_IN_DELTA = DELTA.indexOf('aspirin');
const COUGH_IN_DELTA = DELTA.indexOf('cough');

describe.each([
  ['graph mode (the tenant lane’s consultation.extractEntities node)', true],
  ['legacy mode (the single-call flush)', false],
])('A2 transcript anchors — %s', (_label, graphMode) => {
  it('anchors each entity to the utterance that contains it, with offsets into THAT utterance', async () => {
    const { service, stream, nerCalls } = buildService({
      graphMode,
      entities: () => [nlpEntity('cough', 'SYMPTOM', COUGH_IN_DELTA), nlpEntity('aspirin', 'MEDICATION', ASPIRIN_IN_DELTA)],
    });

    const payload = await speakAndFlush(service, stream);

    // The engine really did run NER over the joined delta these offsets index.
    expect(nerCalls).toContain(DELTA);

    const byText = new Map(payload!.entities.map((e) => [e.text, e]));
    expect([...byText.keys()].sort()).toEqual(['aspirin', 'cough']);

    // `cough` is in the FIRST utterance, so the delta offset and the utterance offset coincide —
    // which is exactly why the second entity is the one that proves the rebasing happened.
    expect(byText.get('cough')).toMatchObject({ transcriptSegmentId: 'utt-0', transcriptStart: 0, transcriptEnd: 5 });

    const aspirin = byText.get('aspirin')!;
    expect(aspirin.transcriptSegmentId).toBe('utt-1');
    // NOT the delta offset: `aspirin` sits at 25 in the joined string and at 6 in its own
    // utterance. Publishing 25 would point past the end of the segment the id names.
    expect(aspirin.transcriptStart).toBe(UTT_1.indexOf('aspirin'));
    expect(UTT_1.slice(aspirin.transcriptStart!, aspirin.transcriptEnd!)).toBe('aspirin');
    expect(aspirin.transcriptStart).not.toBe(ASPIRIN_IN_DELTA);

    // The NOTE offsets are untouched by any of this: `start`/`end` still index `runningSummary`,
    // which is what the highlight overlay paints.
    expect(payload!.runningSummary.slice(aspirin.start!, aspirin.end!).toLowerCase()).toBe('aspirin');
  });

  it('gives NO anchor to an entity whose utterance carried no timing — never a fabricated utt-0', async () => {
    const { service } = buildService({ graphMode, entities: () => [nlpEntity('cough', 'SYMPTOM', 0)] });

    service.start({ consultationId: CID, tenantId: ARCAAI, sessionId: STT_SESSION });
    await settle();
    // The MANUAL ingest path: text and nothing else. `buildGraphSegments` omits an untimed part
    // by construction rather than claim a `start: 0` it never measured, so there is no segment
    // here for an entity to be anchored to.
    service.ingestSegment(CID, { text: UTT_0, isFinal: true, segmentId: 's1' });
    const payload = await service.flush(CID);
    await service.stop(CID, { persistSnapshot: false });

    const [cough] = payload!.entities;
    expect(cough.text).toBe('cough');
    // Grounded to the note as always …
    expect(typeof cough.start).toBe('number');
    // … and carrying no transcript claim at all. Not a partial one: a segment id with no offsets,
    // or offsets into a delta the consumer never sees, are both worse than an absent link.
    expect(cough.transcriptSegmentId).toBeUndefined();
    expect(cough.transcriptStart).toBeUndefined();
    expect(cough.transcriptEnd).toBeUndefined();
  });

  it('does not re-anchor a PRIOR flush’s entity against this flush’s delta', async () => {
    // Flush 1 extracts `cough` from utterance 0; flush 2's delta is utterance 1 alone, and NER
    // answers it with `aspirin`. The merged payload still carries `cough` (recall across flushes),
    // whose anchor was computed against a window that no longer exists — re-deriving it here would
    // resolve utterance 0's offsets inside utterance 1 and cite the wrong turn of the encounter.
    const { service, stream } = buildService({
      graphMode,
      entities: (sourceText) =>
        sourceText === UTT_1 ? [nlpEntity('aspirin', 'MEDICATION', UTT_1.indexOf('aspirin'))] : [nlpEntity('cough', 'SYMPTOM', UTT_0.indexOf('cough'))],
    });

    service.start({ consultationId: CID, tenantId: ARCAAI, sessionId: STT_SESSION });
    await settle();
    stream.emit(frame({ text: UTT_0, startTime: 0, endTime: 2, utteranceIndex: 0 }));
    const first = await service.flush(CID);
    expect(first!.entities.map((e) => e.text)).toEqual(['cough']);
    expect(first!.entities[0]).toMatchObject({ transcriptSegmentId: 'utt-0', transcriptStart: 0 });

    stream.emit(frame({ text: UTT_1, startTime: 2.5, endTime: 4, utteranceIndex: 1 }));
    const second = await service.flush(CID);
    await service.stop(CID, { persistSnapshot: false });

    const byText = new Map(second!.entities.map((e) => [e.text, e]));
    // The NEW entity is anchored to the utterance this flush actually saw …
    expect(byText.get('aspirin')).toMatchObject({ transcriptSegmentId: 'utt-1', transcriptStart: UTT_1.indexOf('aspirin') });
    // … and the CARRIED-FORWARD one still names the utterance it was extracted from, unchanged.
    expect(byText.get('cough')).toMatchObject({ transcriptSegmentId: 'utt-0', transcriptStart: 0, transcriptEnd: 5 });
  });
});
