import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelResidencyService } from '../model-residency.service';
import { confirmationsStub } from './confirmations.stub';
import { routeLmStudioThroughAgent } from './lmstudio-agent-route';
import { toReportedModel } from '../residency-agent.client';

/**
 * TASK-1019 lane Y (Y4) — a model whose load FAILED is visible state in the
 * catalogue: status `failed` with `{code, message, at}` instead of vanishing
 * into `not_loaded`. Reported by a Python agent (`state: 'failed'`), by the
 * stt-worker's `model_resident{state="failed"}` gauge, or recorded by the
 * gateway itself when an LM Studio load operation fails; cleared by the next
 * successful load / unload of that model.
 */

const CATALOGUE_FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../../tests/contracts/model-residency-catalogue.fixture.json'), 'utf8'),
);

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const LIVE_ASR = 'arcaai-whisper-ml-en-ggml';
const NER = 'blaze999/Medical-NER';
const GEMMA = 'gemma-4-e2b-it-qat';
const FAILURE = { code: 'LOAD_FAILED', message: 'no gguf in /models/whisper', at: '2026-09-29T10:00:00Z' };

type Row = Record<string, unknown>;

function agentModel(overrides: Row = {}): Row {
  return {
    modelRef: LIVE_ASR,
    aiModelId: null,
    cache: 'asr',
    state: 'loaded',
    device: 'cuda:0',
    bytes: 1.5 * GiB,
    bytesSource: 'measured',
    inFlight: 0,
    pinned: false,
    adminPinned: false,
    ttlSeconds: 900,
    loadedAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastUsedAt: new Date(Date.now() - 5_000).toISOString(),
    loadSeconds: 6.8,
    ...overrides,
  };
}

function failedModel(overrides: Row = {}): Row {
  return agentModel({
    state: 'failed',
    bytes: null,
    bytesSource: 'unknown',
    inFlight: 0,
    loadedAt: null,
    lastUsedAt: null,
    loadSeconds: null,
    error: FAILURE,
    ...overrides,
  });
}

function aiModel(overrides: Row): Row {
  return {
    tenantId: SYSTEM_TENANT_ID,
    deploymentKind: 'SELF_HOSTED',
    resourceStatus: 'ENABLED',
    observedMemoryMb: null,
    observedLoadSeconds: null,
    memorySizeMb: null,
    provider: 'built-in',
    wireModelId: null,
    format: 'WHISPER_CPP',
    ...overrides,
  };
}

function build() {
  const state = {
    sttModels: [] as Row[],
    nlpModels: [] as Row[],
    lmsModels: [] as Row[],
    workerFailed: false,
    usedMib: { '0': 4_000, '1': 2 } as Record<string, number>,
    catalogue: [
      aiModel({ id: 'model-asr', slug: LIVE_ASR, sourceUri: 's3://hope-models/asr', name: 'ArcaAI Whisper ml-en', servedBy: 'stt', memorySizeMb: 1500 }),
      aiModel({ id: 'model-worker', slug: 'whisper-batch', sourceUri: 's3://hope-models/batch', name: 'Whisper batch', servedBy: 'stt-worker' }),
      aiModel({ id: 'model-ner', slug: 'medical-ner', sourceUri: NER, name: 'Medical NER', servedBy: 'nlp', format: 'SAFETENSOR' }),
      aiModel({
        id: 'model-gemma',
        slug: 'lms-gemma',
        sourceUri: 'lmstudio://gemma',
        name: 'Gemma 4 E2B',
        servedBy: 'lmstudio',
        provider: 'lm-studio',
        wireModelId: GEMMA,
        format: 'GGUF',
        memorySizeMb: 3000, // TASK-1051: a never-measured row with no memorySizeMb is refused 409 NO_SIZE
      }),
    ] as Row[],
  };

  const cls = { get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: ['SUPER_ADMIN'] } : undefined)) };
  const eventEmitter = { emit: vi.fn() };
  const policies = { findAll: vi.fn(async () => []) };
  const aiModels = {
    findAll: vi.fn(async () => state.catalogue),
    findById: vi.fn(async (id: string) => ({ ...state.catalogue.find((m) => m.id === id) })),
    update: vi.fn(async (_id: string, entity: unknown) => entity),
  };
  const agents = {
    report: vi.fn(async (service: 'stt' | 'nlp') => ({
      service,
      instance: `hope-${service}-pod`,
      reportedAt: new Date().toISOString(),
      devices:
        service === 'stt'
          ? [{ id: 'cuda:0', kind: 'gpu', totalBytes: 16 * GiB, freeBytes: 12_000 * MiB }]
          : [{ id: 'cpu', kind: 'cpu', totalBytes: 64 * GiB, freeBytes: 30 * GiB }],
      models: service === 'stt' ? state.sttModels : state.nlpModels,
    })),
    load: vi.fn(),
    unload: vi.fn(),
    setPolicy: vi.fn(),
  };
  const lmStudio = {
    report: vi.fn(async () => ({
      service: 'lm-studio',
      instance: 'hope-lmstudio:1234',
      reportedAt: new Date().toISOString(),
      devices: [],
      models: state.lmsModels,
    })),
    load: vi.fn(async (modelKey: string) => {
      state.usedMib['0'] += 2_048;
      state.lmsModels = [{ modelRef: modelKey, instanceId: modelKey, cache: 'llm', state: 'loaded', device: 'multi', bytes: null, bytesSource: 'unknown', inFlight: null }];
      return { outcome: 'loaded', model: { modelRef: modelKey, instanceId: modelKey, loadSeconds: 98.4, cache: 'llm' } };
    }),
    unload: vi.fn(async (instanceId: string) => {
      state.lmsModels = [];
      return { outcome: 'unloaded', instanceId };
    }),
  };
  const prometheus = {
    instantVector: vi.fn(async (query: string) => {
      const perGpu = (values: Record<string, number>, extra: Record<string, string> = {}) =>
        Object.entries(values).map(([gpu, value]) => ({ metric: { gpu, ...extra }, value }));
      if (query.includes('timestamp(')) return perGpu({ '0': Date.now() / 1000 + 60, '1': Date.now() / 1000 + 60 });
      if (query.includes('FB_USED')) return perGpu(state.usedMib, { modelName: 'NVIDIA RTX 2000 Ada Generation' });
      if (query.includes('FB_FREE')) return perGpu({ '0': 12_000, '1': 15_998 });
      if (query.includes('FB_RESERVED')) return perGpu({ '0': 380, '1': 380 });
      if (query.includes('GPU_UTIL')) return perGpu({ '0': 1.5, '1': 0.3 });
      if (query.includes('model_resident{') && state.workerFailed) {
        return [{ metric: { model: 'whisper-batch', device: 'cuda:0', state: 'failed' }, value: 1 }];
      }
      return [];
    }),
  };
  const effectiveSettings = { resolveEffective: vi.fn(async () => null) };
  const livePath = { read: vi.fn(async () => []) };
  const specs = { build: vi.fn() };
  const usage = { read: vi.fn(async () => new Map()) };

  routeLmStudioThroughAgent(agents as never, lmStudio as never);
  const service = new ModelResidencyService(
    policies as never,
    aiModels as never,
    agents as never,
    prometheus as never,
    effectiveSettings as never,
    livePath as never,
    specs as never,
    usage as never,
    eventEmitter as never,
    cls as never,
    confirmationsStub(),
  );
  Object.assign(service, { measurementPollMs: 1, measurementMaxWaitMs: 50 });
  return { service, state, agents, lmStudio };
}

type Catalogue = Awaited<ReturnType<ModelResidencyService['getCatalogue']>>;
const row = (view: Catalogue, id: string) => view.services.flatMap((s) => s.models).find((m) => m.aiModelId === id)!;

describe('the catalogue shows a failed load (TASK-1019 Y4)', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });

  it('maps a model an agent reports as `failed` to status `failed` with its error, holding no residency', async () => {
    h.state.sttModels = [failedModel()];

    const view = await h.service.getCatalogue();

    const asr = row(view, 'model-asr');
    expect(asr).toMatchObject({ status: 'failed', error: FAILURE, residency: null, modelRef: LIVE_ASR });
    expect(asr.actions).toEqual(['load', 'edit_policy']); // retry is the way out
    const stt = view.services.find((s) => s.service === 'stt')!;
    expect(stt.loadedCount).toBe(0);
    expect(view.devices.flatMap((d) => d.models)).toEqual([]); // a failed model holds no memory
  });

  it('does not list a failed model as a resident model in the admin view', async () => {
    h.state.sttModels = [failedModel()];

    const view = await h.service.getView();

    expect(view.models).toEqual([]);
  });

  it('still lists a failed model the catalogue does not know, with a null aiModelId', async () => {
    h.state.nlpModels = [failedModel({ modelRef: 'someone/Unregistered-NER', cache: 'nlp_token_classifier', device: 'cpu' })];

    const view = await h.service.getCatalogue();

    const nlp = view.services.find((s) => s.service === 'nlp')!;
    expect(nlp.models.find((m) => m.modelRef === 'someone/Unregistered-NER')).toMatchObject({ status: 'failed', aiModelId: null, error: FAILURE });
  });

  it('carries `error: null` on every model that has not failed', async () => {
    h.state.sttModels = [agentModel()];

    const view = await h.service.getCatalogue();

    for (const model of view.services.flatMap((s) => s.models)) {
      expect(model).toHaveProperty('error', null);
    }
    expect(row(view, 'model-asr').status).toBe('loaded');
  });

  it('sorts a failed row after loaded/loading/unloading and before not_loaded', async () => {
    h.state.sttModels = [failedModel()];
    h.state.catalogue.push(
      aiModel({ id: 'model-rad', slug: 'arcaai-whisper-radiology-en-f16', sourceUri: 's3://hope-models/rad', name: 'A radiology', servedBy: 'stt' }),
    );

    const view = await h.service.getCatalogue();

    const order = view.services.find((s) => s.service === 'stt')!.models.map((m) => m.status);
    expect(order).toEqual(['failed', 'not_loaded']);
  });

  it('reads the stt-worker gauge `model_resident{state="failed"}` as a failed model', async () => {
    h.state.workerFailed = true;

    const view = await h.service.getCatalogue();

    expect(row(view, 'model-worker')).toMatchObject({ status: 'failed', error: { code: 'LOAD_FAILED', at: null }, residency: null });
    expect(row(view, 'model-worker').error!.message).toMatch(/stt-worker/);
  });

  it('every status and the `error` key it emits are declared by the catalogue fixture', async () => {
    h.state.sttModels = [failedModel()];

    const view = await h.service.getCatalogue();

    expect(CATALOGUE_FIXTURE.enums.status).toContain('failed');
    const pinned = Object.keys(CATALOGUE_FIXTURE.response.services[0].models[0]).sort();
    for (const model of view.services.flatMap((s) => s.models)) {
      expect(CATALOGUE_FIXTURE.enums.status).toContain(model.status);
      expect(Object.keys(model).sort()).toEqual(pinned);
    }
    expect(Object.keys(row(view, 'model-asr').error!).sort()).toEqual(['at', 'code', 'message']);
  });
});

describe('a failed LM Studio load marks the model failed until the next load or unload (TASK-1019 Y4)', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });

  async function failGemmaLoad(): Promise<void> {
    h.lmStudio.load.mockRejectedValueOnce(new Error('CUDA out of memory'));
    const accepted = await h.service.load({ service: 'lm-studio', modelRef: GEMMA });
    expect(accepted.status).toBe(202);
    await h.service.drain();
  }

  it('records the failure from the operation and reports it as `failed` with code, message and time', async () => {
    await failGemmaLoad();

    const view = await h.service.getCatalogue();

    const gemma = row(view, 'model-gemma');
    expect(gemma.status).toBe('failed');
    expect(gemma.error).toMatchObject({ code: 'LOAD_FAILED', message: 'CUDA out of memory' });
    expect(Number.isNaN(Date.parse(gemma.error!.at as string))).toBe(false);
    expect(gemma.actions).toEqual(['load', 'edit_policy']);
    expect(view.services.find((s) => s.service === 'lm-studio')!.loadedCount).toBe(0);
  });

  it('a successful retry clears it', async () => {
    await failGemmaLoad();

    const retried = await h.service.load({ service: 'lm-studio', modelRef: GEMMA });
    expect(retried.status).toBe(202);
    await h.service.drain();

    const gemma = row(await h.service.getCatalogue(), 'model-gemma');
    expect(gemma.status).toBe('loaded');
    expect(gemma.error).toBeNull();
  });

  it('shows `loading`, not the old failure, while a retry runs', async () => {
    await failGemmaLoad();
    let release!: () => void;
    h.lmStudio.load.mockImplementationOnce(
      (modelKey: string) =>
        new Promise((resolveLoad) => {
          release = () => resolveLoad({ outcome: 'loaded', model: { modelRef: modelKey, instanceId: modelKey, loadSeconds: 1, cache: 'llm' } });
        }),
    );
    await h.service.load({ service: 'lm-studio', modelRef: GEMMA });

    const gemma = row(await h.service.getCatalogue(), 'model-gemma');
    expect(gemma).toMatchObject({ status: 'loading', error: null });

    release();
    await h.service.drain();
  });

  it('an unload of the model clears it', async () => {
    await failGemmaLoad();

    await h.service.unload({ service: 'lm-studio', modelRef: GEMMA, force: true });

    const gemma = row(await h.service.getCatalogue(), 'model-gemma');
    expect(gemma).toMatchObject({ status: 'not_loaded', error: null });
  });

  it('a model LM Studio reports loaded is never failed, whatever the ledger remembers', async () => {
    await failGemmaLoad();
    h.state.lmsModels = [{ modelRef: GEMMA, instanceId: GEMMA, cache: 'llm', state: 'loaded', device: 'multi', bytes: null, bytesSource: 'unknown', inFlight: null }];

    const gemma = row(await h.service.getCatalogue(), 'model-gemma');
    expect(gemma.status).toBe('loaded');
    expect(gemma.error).toBeNull();
  });
});

describe('the agent client keeps a reported failure (TASK-1019 Y4)', () => {
  it('maps state `failed` and its error instead of degrading it to `loaded`', () => {
    const model = toReportedModel({
      model_ref: LIVE_ASR,
      state: 'failed',
      cache: 'asr',
      device: 'cuda:0',
      bytes: null,
      bytes_source: 'unknown',
      error: { code: 'RuntimeError', message: 'weights missing', at: '2026-09-29T10:00:00Z' },
    });

    expect(model.state).toBe('failed');
    expect(model.error).toEqual({ code: 'RuntimeError', message: 'weights missing', at: '2026-09-29T10:00:00Z' });
  });

  it('carries no error on a loaded model, and tolerates an agent that predates the field', () => {
    expect(toReportedModel({ model_ref: 'm', state: 'loaded' }).error ?? null).toBeNull();
    expect(toReportedModel({ model_ref: 'm', state: 'loading' }).state).toBe('loading');
  });
});
