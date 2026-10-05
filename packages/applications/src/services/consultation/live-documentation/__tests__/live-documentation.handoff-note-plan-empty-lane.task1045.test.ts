/**
 * TASK-1045 (live-fix3) — the governed finalizer receives the note plan even when the live lane
 * produced NO note output before the stop.
 *
 * Live run 2026-10-05 (consultation `01a10c38-…`): the stop arrived ~80 ms after start, before the
 * live lane's first flush, so the handoff record carried `outputs: {}`. `withNotePlan` attached the
 * plan only to EXISTING note outputs, so it composed nothing, the finalizer had nothing bound
 * ("core.agent: nothing bound on `in`/`context`"), `n_output` failed its schema and the run ended
 * `OUTPUT_INVALID`. The note's input is the transcript record (the plan), not the live text, so the
 * graph's note nodes — the realtime nodes a durable `onEnd` finalizer reads on `in` — are recorded on
 * the handoff and handed the plan whether or not the live lane reached them.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CompiledWorkflowConfig } from '@arcaai/workflow-contract';

import { LiveDocumentationService } from '../live-documentation.service';
import { buildRealtimeLane } from '../realtime/realtime-lane';

const TENANT = 'tenant-1045';
const CID = 'consultation-1045-empty-lane';
const REF = { consultationId: CID, mode: 'final' as const, planId: '0199a000-0000-7000-8000-0000000000aa' };

const agent = (slug: string, lane: 'realtime' | 'durable', cadence: string) => ({ agentRef: { slug, versionNumber: 1 }, execution: { lane, cadence } });

/** The seeded `general-medicine-consultation` shape (the graph of the live run), trimmed. */
const COMPILED = {
  slug: 'general-medicine-consultation',
  versionNumber: 1,
  stages: [
    { stageIndex: 0, nodes: [{ nodeId: 'n_trigger', type: 'core.trigger', config: {}, inputs: [] }] },
    {
      stageIndex: 1,
      nodes: [
        { nodeId: 'n_asr', type: 'core.agent', config: agent('realtime-transcription', 'realtime', 'perTurn'), inputs: [] },
        {
          nodeId: 'n_presummary',
          type: 'core.agent',
          config: agent('case-notes-pre-summary', 'realtime', 'onStart'),
          inputs: [{ fromNodeId: 'n_trigger', fromPort: 'out', toPort: 'context' }],
        },
      ],
    },
    {
      stageIndex: 2,
      nodes: [
        {
          nodeId: 'n_ner',
          type: 'core.agent',
          config: agent('medical-ner', 'realtime', 'perTurn'),
          inputs: [{ fromNodeId: 'n_asr', fromPort: 'transcript', toPort: 'text' }],
        },
      ],
    },
    {
      stageIndex: 3,
      nodes: [
        {
          nodeId: 'n_summary',
          type: 'core.agent',
          config: agent('general-medicine-summarization', 'realtime', 'perTurn'),
          inputs: [{ fromNodeId: 'n_ner', fromPort: 'out', toPort: 'in' }],
        },
      ],
    },
    {
      stageIndex: 4,
      nodes: [
        {
          nodeId: 'n_finalize',
          type: 'core.agent',
          config: agent('casenote-finalization', 'durable', 'onEnd'),
          inputs: [
            { fromNodeId: 'n_presummary', fromPort: 'next', toPort: 'after' },
            { fromNodeId: 'n_summary', fromPort: 'out', toPort: 'in' },
          ],
        },
      ],
    },
    {
      stageIndex: 5,
      nodes: [{ nodeId: 'n_output', type: 'core.output', config: {}, inputs: [{ fromNodeId: 'n_finalize', fromPort: 'data', toPort: 'in' }] }],
    },
  ],
} as unknown as CompiledWorkflowConfig;

function buildService(opts: { record?: unknown; composer?: { composeNotePlan: ReturnType<typeof vi.fn> } | null } = {}) {
  const stored = new Map<string, string>();
  if (opts.record !== undefined) stored.set(`live-doc:handoff:${CID}`, JSON.stringify(opts.record));
  const cache = {
    get: vi.fn(async (key: string) => stored.get(key) ?? null),
    exists: vi.fn(async (key: string) => stored.has(key)),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      stored.set(key, value);
    }),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };
  const composer =
    opts.composer === null
      ? undefined
      : (opts.composer ?? { composeNotePlan: vi.fn().mockResolvedValue({ notePlanRef: REF, strategy: 'single_pass', callCount: 1 }) });
  const args: unknown[] = new Array(34).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  args[15] = {
    findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, doctorId: 'doctor-1', departmentId: null, status: 'STOPPED', metadata: null })),
  };
  args[32] = composer;
  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, composer, stored };
}

describe('buildRealtimeLane — the note nodes the durable finalizer reads', () => {
  it('names the realtime nodes an onEnd core.agent reads on `in` (never a control edge, never NER)', () => {
    const lane = buildRealtimeLane(COMPILED);

    expect(lane?.handoffNoteNodeIds).toEqual(['n_summary']);
  });

  it('names both visit-type summaries of a split graph', () => {
    const split = structuredClone(COMPILED) as unknown as { stages: { nodes: Record<string, unknown>[] }[] };
    split.stages[3].nodes.push({
      nodeId: 'n_summary_revisit',
      type: 'core.agent',
      config: agent('revisit-summarization', 'realtime', 'perTurn'),
      inputs: [{ fromNodeId: 'n_ner', fromPort: 'out', toPort: 'in' }],
    });
    (split.stages[4].nodes[0].inputs as unknown[]).push({ fromNodeId: 'n_summary_revisit', fromPort: 'out', toPort: 'in' });

    expect(buildRealtimeLane(split as unknown as CompiledWorkflowConfig)?.handoffNoteNodeIds).toEqual(['n_summary', 'n_summary_revisit']);
  });
});

describe('readLiveHandoff — the plan reaches the finalizer when the live lane produced no note (TASK-1045 live-fix3)', () => {
  it('composes the plan and hands it on the recorded note node, though the record carries no output for it', async () => {
    const record = { endedAt: '2026-10-05T13:20:22.093Z', tenantId: TENANT, outputs: {}, noteNodeIds: ['n_summary'] };
    const { service, composer } = buildService({ record });

    const answer = await service.readLiveHandoff(CID, ['n_asr', 'n_ner', 'n_presummary', 'n_summary']);

    expect(answer.ended).toBe(true);
    expect(composer!.composeNotePlan).toHaveBeenCalledWith(CID, { tenantId: TENANT, mode: 'final' }, { documentTemplateSlug: null });
    expect(answer.outputs).toEqual({ n_summary: { text: '', note_plan_ref: REF } });
  });

  it('composes the plan against the document template the live session froze (E2E-27)', async () => {
    const record = {
      endedAt: '2026-10-05T19:33:41.000Z',
      tenantId: TENANT,
      outputs: {},
      noteNodeIds: ['n_summary'],
      documentHeadings: ['New Complaints', 'Treatment Plan'],
      documentTemplateSlug: 'arcaai-bren-soap-new-visit',
    };
    const { service, composer } = buildService({ record });

    await service.readLiveHandoff(CID, ['n_summary']);

    expect(composer!.composeNotePlan).toHaveBeenCalledWith(
      CID,
      { tenantId: TENANT, mode: 'final' },
      { documentTemplateSlug: 'arcaai-bren-soap-new-visit' },
    );
  });

  it('a fail-closed composer refusal reaches the note node as `note_plan_error`', async () => {
    const { BadRequestException } = await import('@nestjs/common');
    const composer = { composeNotePlan: vi.fn().mockRejectedValue(new BadRequestException({ code: 'NOTE_INPUT_EXCEEDS_CONTEXT' })) };
    const record = { endedAt: '2026-10-05T13:20:22.093Z', tenantId: TENANT, outputs: {}, noteNodeIds: ['n_summary'] };
    const { service } = buildService({ record, composer });

    const answer = await service.readLiveHandoff(CID, ['n_summary']);

    expect(answer.outputs).toEqual({ n_summary: { text: '', note_plan_error: 'NOTE_INPUT_EXCEEDS_CONTEXT' } });
  });

  it('only for a note node the caller asked about', async () => {
    const record = { endedAt: '2026-10-05T13:20:22.093Z', tenantId: TENANT, outputs: {}, noteNodeIds: ['n_summary'] };
    const { service, composer } = buildService({ record });

    const answer = await service.readLiveHandoff(CID, ['n_asr']);

    expect(answer.outputs).toEqual({});
    expect(composer!.composeNotePlan).not.toHaveBeenCalled();
  });

  it('a record written before note nodes were recorded keeps the old answer', async () => {
    const record = { endedAt: '2026-10-05T13:20:22.093Z', tenantId: TENANT, outputs: {} };
    const { service, composer } = buildService({ record });

    const answer = await service.readLiveHandoff(CID, ['n_summary']);

    expect(answer.outputs).toEqual({});
    expect(composer!.composeNotePlan).not.toHaveBeenCalled();
  });

  it('without a composer wired, no placeholder is handed over', async () => {
    const record = { endedAt: '2026-10-05T13:20:22.093Z', tenantId: TENANT, outputs: {}, noteNodeIds: ['n_summary'] };
    const { service } = buildService({ record, composer: null });

    const answer = await service.readLiveHandoff(CID, ['n_summary']);

    expect(answer.outputs).toEqual({});
  });
});

describe('the stop records the lane note nodes on the handoff', () => {
  it('persists `noteNodeIds` from the frozen lane even when the session produced no output', async () => {
    const { service, stored } = buildService();
    const session = { consultationId: CID, tenantId: TENANT, liveNodeOutputs: {}, laneSnapshot: buildRealtimeLane(COMPILED) };

    await (service as unknown as { persistLiveHandoff(s: unknown): Promise<void> }).persistLiveHandoff(session);

    const written = JSON.parse(stored.get(`live-doc:handoff:${CID}`)!);
    expect(written.outputs).toEqual({});
    expect(written.noteNodeIds).toEqual(['n_summary']);
  });

  it('records nothing for a lane with no durable finalizer reading it (the platform lane)', async () => {
    const { PLATFORM_REALTIME_LANE } = await import('../realtime/realtime-lane');
    const { service, stored } = buildService();
    const session = { consultationId: CID, tenantId: TENANT, liveNodeOutputs: {}, laneSnapshot: PLATFORM_REALTIME_LANE };

    await (service as unknown as { persistLiveHandoff(s: unknown): Promise<void> }).persistLiveHandoff(session);

    expect(JSON.parse(stored.get(`live-doc:handoff:${CID}`)!).noteNodeIds).toBeUndefined();
  });
});
