/**
 * TASK-1042 (C2, C3, C8) — binding a live STT session to a STANDALONE workflow run.
 *
 * Order of the checks (each pinned below): shape (400) → settings `socket` (400) → ownership (404,
 * the same body as an unknown session) → live (409) → unbound or bound to THIS run (409) → agent
 * agreement with the graph's single STT node (409) → OCC bind.
 */
import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { describe, expect, it, vi } from 'vitest';
import {
  RunAudioBindingService,
  assertNoLiveAudio,
  liveAudioRequestsIn,
  type RunAudioWorkflow,
} from '../run-audio-binding.service';
import { readBoundRun, readSessionOwner } from '../run-audio-metadata';

const TENANT = 't-1';
const RUN_ID = 'run-1';
const SESSION = 'stt-1';

function compiledConfig(options: { connections?: string[] | null; audioKeys?: string[] } = {}): Record<string, unknown> {
  const audioKeys = options.audioKeys ?? ['audio'];
  const properties: Record<string, unknown> = { note: { type: 'string' } };
  for (const key of audioKeys) properties[key] = { type: 'object', properties: { sttSessionId: { type: 'string', minLength: 1 } } };
  return {
    stages: [
      {
        nodes: [
          { nodeId: 'trigger', type: 'core.trigger', config: { contextSchema: { resolved: { type: 'object', properties } } } },
          { nodeId: 'asr', type: 'core.agent', config: { agentRef: { slug: 'asr-agent' } } },
        ],
      },
    ],
    ...(options.connections === null ? {} : { settings: { connections: options.connections ?? ['api', 'socket'], sources: [] } }),
  };
}

function workflow(overrides: Partial<RunAudioWorkflow> = {}): RunAudioWorkflow {
  return { slug: 'dictate', versionNumber: 3, compiledConfig: compiledConfig(), graph: null, ...overrides };
}

interface FakeJob {
  id: string;
  tenantId: string;
  version: number;
  status: string;
  completedAt: Date | null;
  consultationId: string | null;
  streamSessionId: string;
  resolvedSpec: unknown;
  metaData: Record<string, unknown> | null | undefined;
}

function job(overrides: Partial<FakeJob> = {}): FakeJob {
  return {
    id: 'job-1',
    tenantId: TENANT,
    version: 4,
    status: 'PROCESSING',
    completedAt: null,
    consultationId: null,
    streamSessionId: SESSION,
    resolvedSpec: { agent: { slug: 'asr-agent', versionId: 'agent-v1', source: 'workflow' } },
    metaData: { owner: { type: 'apiKey', id: 'key-A' } },
    ...overrides,
  };
}

function setup(
  options: {
    jobs?: FakeJob[];
    caller?: { type: string; id: string } | null;
    asrAgent?: string | null | 'ambiguous';
    maxSeconds?: number;
    occ?: 'lose-to-other' | 'lose-to-same';
  } = {},
) {
  const rows = options.jobs ?? [job()];
  const findAll = vi.fn(async () => rows.map((row) => ({ ...row })));
  const updateWithVersion = vi.fn(async (_id: string, entity: FakeJob, expected: number) => {
    if (options.occ) {
      const winner = options.occ === 'lose-to-same' ? RUN_ID : 'run-other';
      rows[0] = { ...rows[0], version: expected + 1, metaData: { ...(rows[0].metaData ?? {}), boundRun: { runId: winner } } };
      throw new OptimisticConcurrencyException('transcriptionJob', entity.id, { expectedVersion: expected, currentVersion: expected + 1 });
    }
    rows[0] = { ...entity, version: expected + 1 };
    return rows[0];
  });
  const jobs = { findAll, updateWithVersion };
  const runAccess = { currentPrincipal: vi.fn(() => (options.caller === undefined ? { type: 'apiKey', id: 'key-A' } : options.caller)) };
  const asrReader = {
    findAsrAgent: vi.fn(async () => {
      if (options.asrAgent === 'ambiguous') throw new ConflictException({ code: 'WORKFLOW_ASR_AGENT_UNAVAILABLE', message: 'two' });
      const slug = options.asrAgent === undefined ? 'asr-agent' : options.asrAgent;
      return slug === null ? null : { workflowDefinitionSlug: 'dictate', agentSlug: slug, nodeId: 'asr' };
    }),
  };
  const settings = { resolve: vi.fn(() => ({ value: options.maxSeconds ?? 3600 })) };
  const service = new RunAudioBindingService(jobs as never, runAccess as never, asrReader as never, settings as never);
  return { service, jobs, runAccess, asrReader, settings, rows };
}

const audioInput = (sttSessionId: unknown = SESSION) => ({ note: 'hello', audio: { sttSessionId } });

async function refusal(promise: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const response = error.getResponse();
    return { status: error.getStatus(), body: (typeof response === 'object' ? response : { message: response }) as Record<string, unknown> };
  }
  throw new Error('expected a refusal');
}

describe('liveAudioRequestsIn (pure)', () => {
  it('finds every top-level key whose value names an sttSessionId, and nothing else', () => {
    expect(liveAudioRequestsIn({ note: 'x', audio: { sttSessionId: 's' }, other: { a: 1 } })).toEqual([{ key: 'audio', sttSessionId: 's' }]);
    expect(liveAudioRequestsIn(undefined)).toEqual([]);
    expect(liveAudioRequestsIn({ list: [{ sttSessionId: 's' }] })).toEqual([]);
  });
});

describe('RunAudioBindingService.bind — no live audio', () => {
  it('a run with no sttSessionId anywhere is untouched: null and no reads', async () => {
    const { service, jobs, asrReader, settings } = setup();
    await expect(service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: { note: 'x' } })).resolves.toBeNull();
    expect(jobs.findAll).not.toHaveBeenCalled();
    expect(asrReader.findAsrAgent).not.toHaveBeenCalled();
    expect(settings.resolve).not.toHaveBeenCalled();
  });
});

describe('RunAudioBindingService.bind — 400 shape and settings (C3)', () => {
  it('400 RUN_AUDIO_INPUT_UNDECLARED: sttSessionId on a key that is not a stream-audio Input kind', async () => {
    const { service, jobs } = setup();
    const r = await refusal(service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: { note: { sttSessionId: SESSION } } }));
    expect(r).toMatchObject({ status: 400, body: { code: 'RUN_AUDIO_INPUT_UNDECLARED' } });
    expect(jobs.findAll).not.toHaveBeenCalled();
  });

  it('400 RUN_AUDIO_INPUT_UNDECLARED: a trigger that declares no input shape declares no live audio', async () => {
    const { service } = setup();
    const unbound = { stages: [{ nodes: [{ nodeId: 'trigger', type: 'core.trigger', config: {} }] }], settings: { connections: ['api', 'socket'], sources: [] } };
    const r = await refusal(service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow({ compiledConfig: unbound }), input: audioInput() }));
    expect(r).toMatchObject({ status: 400, body: { code: 'RUN_AUDIO_INPUT_UNDECLARED' } });
  });

  it('400 RUN_AUDIO_MULTIPLE: sttSessionId on more than one key', async () => {
    const { service } = setup();
    const wf = workflow({ compiledConfig: compiledConfig({ audioKeys: ['audio', 'mic2'] }) });
    const r = await refusal(service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: wf, input: { audio: { sttSessionId: 'a' }, mic2: { sttSessionId: 'b' } } }));
    expect(r).toMatchObject({ status: 400, body: { code: 'RUN_AUDIO_MULTIPLE' } });
  });

  it('400 when sttSessionId is not a non-empty string', async () => {
    const { service } = setup();
    const r = await refusal(service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput('') }));
    expect(r.status).toBe(400);
  });

  it('400 LIVE_AUDIO_UNSUPPORTED: the settings do not admit `socket`', async () => {
    const { service, jobs } = setup();
    const wf = workflow({ compiledConfig: compiledConfig({ connections: ['api', 'sse'] }) });
    const r = await refusal(service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: wf, input: audioInput() }));
    expect(r).toMatchObject({ status: 400, body: { code: 'LIVE_AUDIO_UNSUPPORTED' } });
    expect(jobs.findAll).not.toHaveBeenCalled();
  });

  it('400 LIVE_AUDIO_UNSUPPORTED: a legacy definition without settings', async () => {
    const { service } = setup();
    const wf = workflow({ compiledConfig: compiledConfig({ connections: null }) });
    const r = await refusal(service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: wf, input: audioInput() }));
    expect(r).toMatchObject({ status: 400, body: { code: 'LIVE_AUDIO_UNSUPPORTED' } });
  });
});

describe('RunAudioBindingService.bind — 404 ownership (C3, C8)', () => {
  const notFound = async (s: ReturnType<typeof setup>) => {
    const r = await refusal(s.service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput() }));
    expect(r.status).toBe(404);
    expect(s.jobs.updateWithVersion).not.toHaveBeenCalled();
    return r.body;
  };

  it('an unknown session, another tenant`s, another principal`s, and an ownerless one all answer the SAME 404', async () => {
    const unknown = await notFound(setup({ jobs: [] }));
    const foreign = await notFound(setup({ jobs: [job({ tenantId: 't-2' })] }));
    const otherKey = await notFound(setup({ caller: { type: 'apiKey', id: 'key-B' } }));
    const sameIdOtherClass = await notFound(setup({ caller: { type: 'user', id: 'key-A' } }));
    const ownerless = await notFound(setup({ jobs: [job({ metaData: null })] }));
    const noCaller = await notFound(setup({ caller: null }));
    for (const body of [foreign, otherKey, sameIdOtherClass, ownerless, noCaller]) expect(body).toEqual(unknown);
    expect(JSON.stringify(unknown)).not.toMatch(/owner|tenant|principal/i);
  });

  it('a service account binds the session it opened', async () => {
    const { service } = setup({ jobs: [job({ metaData: { owner: { type: 'serviceAccount', id: 'sa-1' } } })], caller: { type: 'serviceAccount', id: 'sa-1' } });
    await expect(service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput() })).resolves.not.toBeNull();
  });
});

describe('RunAudioBindingService.bind — 409 state (C3)', () => {
  it('409 RUN_AUDIO_SESSION_NOT_LIVE: the session ended (status, or completedAt)', async () => {
    for (const ended of [job({ status: 'COMPLETED' }), job({ completedAt: new Date() }), job({ status: 'FAILED' })]) {
      const r = await refusal(setup({ jobs: [ended] }).service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput() }));
      expect(r).toMatchObject({ status: 409, body: { code: 'RUN_AUDIO_SESSION_NOT_LIVE' } });
    }
  });

  it('409 RUN_AUDIO_SESSION_BOUND_ELSEWHERE: bound to a consultation', async () => {
    const r = await refusal(setup({ jobs: [job({ consultationId: 'c-1' })] }).service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput() }));
    expect(r).toMatchObject({ status: 409, body: { code: 'RUN_AUDIO_SESSION_BOUND_ELSEWHERE' } });
  });

  it('409 RUN_AUDIO_SESSION_BOUND_ELSEWHERE: bound to another run', async () => {
    const bound = job({ metaData: { owner: { type: 'apiKey', id: 'key-A' }, boundRun: { runId: 'run-other', workflowSlug: 'dictate', versionNumber: 3, boundAt: 'x' } } });
    const r = await refusal(setup({ jobs: [bound] }).service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput() }));
    expect(r).toMatchObject({ status: 409, body: { code: 'RUN_AUDIO_SESSION_BOUND_ELSEWHERE' } });
  });

  it('409 RUN_AUDIO_AGENT_MISMATCH: the session`s ASR agent is not the graph`s STT node agent', async () => {
    const r = await refusal(setup({ asrAgent: 'other-asr' }).service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput() }));
    expect(r).toMatchObject({ status: 409, body: { code: 'RUN_AUDIO_AGENT_MISMATCH' } });
  });

  it('409 RUN_AUDIO_AGENT_MISMATCH: the graph has no STT node, or more than one', async () => {
    for (const asrAgent of [null, 'ambiguous'] as const) {
      const r = await refusal(setup({ asrAgent }).service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput() }));
      expect(r).toMatchObject({ status: 409, body: { code: 'RUN_AUDIO_AGENT_MISMATCH' } });
    }
  });
});

describe('RunAudioBindingService.bind — the bind (C8, C7)', () => {
  it('binds with OCC (boundRun on the job) and returns the C7 liveAudio with the resolved ceiling', async () => {
    const s = setup({ maxSeconds: 1200 });
    const binding = await s.service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput() });
    expect(binding?.liveAudio).toEqual({ sttSessionId: SESSION, maxWaitSeconds: 1200 });
    expect(s.settings.resolve).toHaveBeenCalledWith('workflowRuns.liveAudioMaxSeconds', TENANT);
    expect(s.jobs.updateWithVersion).toHaveBeenCalledTimes(1);
    const [id, entity, expected] = s.jobs.updateWithVersion.mock.calls[0];
    expect([id, expected]).toEqual(['job-1', 4]);
    expect(readBoundRun((entity as FakeJob).metaData)).toMatchObject({ runId: RUN_ID, workflowSlug: 'dictate', versionNumber: 3 });
    expect(readSessionOwner((entity as FakeJob).metaData)).toEqual({ type: 'apiKey', id: 'key-A' });
  });

  it('an idempotent retry of the same start is accepted with no second bind', async () => {
    const bound = job({ metaData: { owner: { type: 'apiKey', id: 'key-A' }, boundRun: { runId: RUN_ID, workflowSlug: 'dictate', versionNumber: 3, boundAt: 'x' } } });
    const s = setup({ jobs: [bound] });
    const binding = await s.service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput() });
    expect(binding?.liveAudio.sttSessionId).toBe(SESSION);
    expect(s.jobs.updateWithVersion).not.toHaveBeenCalled();
    // …and releasing a binding this call did not make never unbinds it.
    await binding?.release();
    expect(s.jobs.updateWithVersion).not.toHaveBeenCalled();
  });

  it('two concurrent starts on one session: the OCC loser gets 409 RUN_AUDIO_SESSION_BOUND_ELSEWHERE', async () => {
    const r = await refusal(setup({ occ: 'lose-to-other' }).service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput() }));
    expect(r).toMatchObject({ status: 409, body: { code: 'RUN_AUDIO_SESSION_BOUND_ELSEWHERE' } });
  });

  it('an OCC loss to the SAME run (a concurrent retry) is accepted', async () => {
    await expect(setup({ occ: 'lose-to-same' }).service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput() })).resolves.not.toBeNull();
  });

  it('release() unbinds a session this call bound (the harness start failed)', async () => {
    const s = setup();
    const binding = await s.service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput() });
    await binding?.release();
    expect(s.jobs.updateWithVersion).toHaveBeenCalledTimes(2);
    expect(readBoundRun(s.rows[0].metaData)).toBeNull();
    expect(readSessionOwner(s.rows[0].metaData)).toEqual({ type: 'apiKey', id: 'key-A' });
  });

  it('an out-of-range ceiling falls back to the 3600 s default', async () => {
    const binding = await setup({ maxSeconds: 0 }).service.bind({ tenantId: TENANT, runId: RUN_ID, workflow: workflow(), input: audioInput() });
    expect(binding?.liveAudio.maxWaitSeconds).toBe(3600);
  });
});

describe('assertNoLiveAudio — the consultation-bound route', () => {
  it('400 LIVE_AUDIO_UNSUPPORTED when input names an sttSessionId; silent otherwise', () => {
    expect(() => assertNoLiveAudio({ note: 'x' })).not.toThrow();
    try {
      assertNoLiveAudio(audioInput());
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'LIVE_AUDIO_UNSUPPORTED' });
    }
  });
});

