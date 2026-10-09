import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpException } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';
import { vi } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { ModelResidencyService } from '../model-residency.service';

/**
 * TASK-1055 — the gateway residency controller's test harness (shared by the lane-G suite and the
 * post-merge review suite): a two-card node (fixture `gateway` numbers), stt / nlp / LM Studio agents
 * reporting both cards by UUID, and a SYSTEM catalogue of the models the fixtures name.
 */
export const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../../tests/contracts/model-residency-task1055.fixture.json'), 'utf8'),
);

export const MiB = 1024 * 1024;
export const CARD = 17_175_674_880; // 16 380 MiB: used + free + 380 reserved
export const UUID0 = 'GPU-be50f6fc-59ec-9c5b-c925-c962344c734c';
export const UUID1 = 'GPU-55c35bac-8291-a08a-2cb2-a43648336aa5';
export const GLIGUARD = 'fastino/gliguard-LLMGuardrails-300M';
export const NER = 'blaze999/Medical-NER';
export const GEMMA = 'gemma-4-e2b-it-qat';
export const GRANITE = 'granite-guardian-4.1-8b';
export const ASR = 'arcaai-whisper-ml-en-ggml';

export type Row = Record<string, unknown>;

export function agentModel(overrides: Row = {}): Row {
  return {
    modelRef: ASR,
    aiModelId: null,
    cache: 'asr',
    state: 'loaded',
    device: 'cuda:0',
    bytes: 1_500 * MiB,
    bytesSource: 'measured',
    inFlight: 0,
    pinned: false,
    adminPinned: false,
    ttlSeconds: 900,
    loadedAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastUsedAt: new Date(Date.now() - 1_800_000).toISOString(),
    loadSeconds: 6.8,
    ...overrides,
  };
}

export function lmsModel(overrides: Row = {}): Row {
  return agentModel({
    modelRef: GEMMA,
    engineKey: `${GEMMA}@q4_0`,
    instanceId: GEMMA,
    cache: 'llm',
    device: 'cuda:1',
    bytes: 4 * 1024 * MiB,
    bytesSource: 'measured',
    deviceBytes: { 'cuda:1': 4 * 1024 * MiB },
    inFlight: null,
    ttlSeconds: null,
    loadConfig: {
      contextLength: 65536,
      parallel: 10,
      flashAttention: true,
      kvCacheQuant: { k: 'f16', v: 'f16' },
      gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0], customRatio: [] },
    },
    ...overrides,
  });
}

export function aiModel(overrides: Row): Row {
  return {
    tenantId: SYSTEM_TENANT_ID,
    servedBy: 'stt',
    observedMemoryMb: null,
    observedLoadSeconds: null,
    memorySizeMb: 1_000,
    resourceStatus: 'ENABLED',
    name: 'model',
    format: 'GGUF',
    version: 3,
    metaData: {},
    ...overrides,
  };
}

export const gpuDevices = () => [
  { id: 'cuda:0', kind: 'gpu', totalBytes: CARD, freeBytes: 0, index: 0, name: 'NVIDIA RTX 2000 Ada Generation', uuid: UUID0 },
  { id: 'cuda:1', kind: 'gpu', totalBytes: CARD, freeBytes: 0, index: 1, name: 'NVIDIA RTX 2000 Ada Generation', uuid: UUID1 },
];

export function build(opts: { enforce?: boolean } = {}) {
  const state = {
    settings: { 'residency.enforce': opts.enforce ?? false } as Record<string, unknown>,
    // DCGM, in MiB (the exporter's unit). gpu0 holds the live path; gpu1 is nearly empty (fixture `gateway` numbers).
    freeMib: { '0': 1_843.2, '1': 13_830 } as Record<string, number>,
    usedMib: { '0': 14_156.8, '1': 2_170 } as Record<string, number>,
    dcgmUuid: { '0': UUID0, '1': UUID1 } as Record<string, string>,
    devices: { stt: gpuDevices(), nlp: gpuDevices(), 'lm-studio': gpuDevices() } as Record<string, Row[]>,
    models: { stt: [agentModel()], nlp: [], 'lm-studio': [lmsModel()] } as Record<string, Row[]>,
    reachable: { stt: true, nlp: true, 'lm-studio': true } as Record<string, boolean>,
    catalogue: [
      aiModel({ id: 'model-asr', slug: ASR, sourceUri: 's3://asr', name: 'ArcaAI Whisper ml-en', servedBy: 'stt' }),
      aiModel({ id: 'model-gliguard', slug: 'gliguard', sourceUri: GLIGUARD, name: 'GLiGuard', servedBy: 'nlp', observedMemoryMb: 1_136 }),
      aiModel({ id: 'model-ner', slug: 'medical-ner', sourceUri: NER, name: 'Medical NER', servedBy: 'nlp', taskType: 'TOKEN_CLASSIFICATION' }),
      aiModel({
        id: 'model-gemma',
        slug: 'lms-gemma-4-e2b-it-qat',
        sourceUri: GEMMA,
        wireModelId: GEMMA,
        name: 'Gemma 4 E2B',
        servedBy: 'lmstudio',
        provider: 'lm-studio',
        observedMemoryMb: 4_096,
        metaData: {
          contextLength: 65536,
          serving: { contextLength: 65536, parallel: 10, gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0] } },
        },
      }),
      aiModel({
        id: 'model-granite',
        slug: GRANITE,
        sourceUri: GRANITE,
        wireModelId: GRANITE,
        name: 'Granite Guardian',
        servedBy: 'lmstudio',
        provider: 'lm-studio',
        observedMemoryMb: 4_900,
        metaData: {
          serving: {
            contextLength: 16384,
            parallel: 10,
            flashAttention: true,
            gpuSplit: { strategy: 'priorityOrder', priority: [0], disabledGpus: [1] },
            kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
          },
        },
      }),
    ] as Row[],
    policies: [] as Row[],
    livePath: [] as Row[],
    usage: new Map<string, Row>(),
  };

  const cls = {
    get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: ['SUPER_ADMIN'] } : key === 'tenantId' ? undefined : undefined)),
  };
  const eventEmitter = { emit: vi.fn() };
  const policies = { findAll: vi.fn(async () => state.policies), create: vi.fn(), updateWithVersion: vi.fn(), softDelete: vi.fn() };
  const aiModels = {
    findAll: vi.fn(async () => state.catalogue),
    findById: vi.fn(async (id: string) => {
      const row = state.catalogue.find((m) => m.id === id);
      if (!row) throw new DataNotFoundException('aiModel', id);
      return { ...row };
    }),
    findBySlug: vi.fn(async (_t: string, slug: string) => state.catalogue.find((m) => m.slug === slug) ?? null),
    findByProviderAndSourceUri: vi.fn(
      async (_t: string, provider: string, sourceUri: string) =>
        state.catalogue.find((m) => m.provider === provider && m.sourceUri === sourceUri) ?? null,
    ),
    update: vi.fn(async (id: string, entity: Row) => {
      const index = state.catalogue.findIndex((m) => m.id === id);
      state.catalogue[index] = { ...entity };
      return state.catalogue[index];
    }),
    updateWithVersion: vi.fn(async (id: string, entity: Row) => {
      const index = state.catalogue.findIndex((m) => m.id === id);
      state.catalogue[index] = { ...entity, version: Number(entity.version ?? 0) + 1 };
      return state.catalogue[index];
    }),
  };
  // An agent reads the free memory of the PHYSICAL card it sees (matched here by uuid).
  const gpuOf = (uuid: unknown) => Object.keys(state.dcgmUuid).find((gpu) => state.dcgmUuid[gpu] === uuid);
  const agentDevices = (service: string) =>
    state.devices[service].map((d) => ({
      ...d,
      freeBytes: d.kind === 'gpu' ? Math.round((state.freeMib[gpuOf(d.uuid) ?? '0'] ?? 0) * MiB) : d.freeBytes,
    }));
  const agents = {
    report: vi.fn(async (service: string) => {
      if (!state.reachable[service]) throw Object.assign(new Error(`${service} down`), { code: 'SERVICE_UNREACHABLE' });
      return {
        service,
        instance: `hope-${service}-pod`,
        reportedAt: new Date().toISOString(),
        devices: agentDevices(service),
        models: state.models[service],
      };
    }),
    load: vi.fn(async (_service: string, request: { modelRef: string; device?: string }) => ({
      outcome: 'loaded',
      model: agentModel({ modelRef: request.modelRef, bytes: 1_100 * MiB, loadSeconds: 1.2, device: request.device ?? 'cuda:0' }),
    })),
    unload: vi.fn(async (_service: string, request: { modelRef: string }) => ({ outcome: 'unloaded', modelRef: request.modelRef })),
    setPolicy: vi.fn(async (_service: string, modelRef: string) => agentModel({ modelRef })),
  };
  const prometheus = {
    instantVector: vi.fn(async (query: string) => {
      const perGpu = (values: Record<string, number>, extra: (gpu: string) => Record<string, string> = () => ({})) =>
        Object.entries(values).map(([gpu, value]) => ({ metric: { gpu, ...extra(gpu) }, value }));
      if (query.includes('FB_USED'))
        return perGpu(state.usedMib, (gpu) => ({ modelName: 'NVIDIA RTX 2000 Ada Generation', UUID: state.dcgmUuid[gpu] }));
      if (query.includes('FB_FREE')) return perGpu(state.freeMib);
      if (query.includes('FB_RESERVED')) return perGpu({ '0': 380, '1': 380 });
      return [];
    }),
  };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) => {
      if (key in state.settings) return { key, value: state.settings[key], sourceScope: 'system' };
      if (key.startsWith('lmStudio.serving.')) return { key, value: HOPE_SETTINGS_REGISTRY.getOrThrow(key).default, sourceScope: 'code-default' };
      return null;
    }),
  };
  const livePath = {
    read: vi.fn(async () => state.livePath),
    status: vi.fn(() => ({ at: Date.now(), error: null, liveAssignments: 0, consumers: 0 })),
  };
  const specs = { build: vi.fn(async (_service: string, modelRef: string) => ({ cache: 'nlp_gliner2_guard', model_path: `/models/${modelRef}` })) };
  const usage = { read: vi.fn(async () => ({ get: (id: string) => state.usage.get(id) })) };

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
  );
  return { service, state, eventEmitter, aiModels, agents, policies, effectiveSettings };
}

export async function refusal(promise: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const error = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
  if (!(error instanceof HttpException)) throw error;
  return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
}

export const audits = (h: ReturnType<typeof build>) =>
  h.eventEmitter.emit.mock.calls.map(([, event]) => (event as { data?: Row }).data ?? {}).filter((d) => typeof d.action === 'string');
