/**
 * TASK-1051 lane C1 — builders for catalogue rows used by the screen and its
 * component tests. Shapes track `tests/contracts/model-residency-catalogue.fixture.json`.
 */

import type {
  ModelResidencyCatalogueResponse,
  ResidencyCatalogueModel,
  ResidencyCpuSummary,
  ResidencyDevice,
  ResidencyServiceGroup,
  ResidencySuggestion,
} from '../../api/types';

const GiB = 1024 ** 3;

export function makeModel(overrides: Partial<ResidencyCatalogueModel> = {}): ResidencyCatalogueModel {
  const modelRef = overrides.modelRef ?? 'model-ref';
  return {
    aiModelId: '0199a1b2-0000-7000-8000-000000000099',
    name: 'Some model',
    kind: 'resident',
    slug: modelRef,
    modelRef,
    format: 'WHISPER_CPP',
    status: 'not_loaded',
    error: null,
    size: { bytes: 1.5 * GiB, source: 'catalogue' },
    budgetBytes: 1.8 * GiB,
    identity: { matched: true, runtimeKeys: [modelRef], reportedKey: null, candidates: [] },
    loadSeconds: null,
    residency: null,
    usage: {
      agentCount: 0,
      tenantCount: 0,
      liveConsultation: false,
      uses: [],
      consumers: { agents: 0, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
    },
    keepPolicy: {
      kind: 'on_demand',
      label: 'Load when needed',
      reason: 'Default for models no live agent uses',
      source: 'default',
      policyId: null,
      policyVersion: null,
      idleTtlSeconds: 900,
    },
    actions: ['load', 'edit_policy'],
    ...overrides,
  };
}

export function makeDevice(overrides: Partial<ResidencyDevice> = {}): ResidencyDevice {
  return {
    id: 'gpu0',
    kind: 'gpu',
    label: 'GPU 0 — NVIDIA RTX 2000 Ada Generation',
    totalBytes: 16 * GiB,
    usedBytes: 6 * GiB,
    freeBytes: 10 * GiB,
    utilisationPercent: 12,
    headroomPercent: 15,
    headroomBytes: 2.4 * GiB,
    overHeadroom: false,
    attributedBytes: 4 * GiB,
    unattributedBytes: 2 * GiB,
    models: [
      { service: 'stt', modelRef: 'whisper-ml-en', name: 'ArcaAI Whisper ml-en', bytes: 1.5 * GiB, bytesSource: 'measured' },
      { service: 'lm-studio', modelRef: 'gemma', name: 'Gemma 4 E2B', bytes: 2.5 * GiB, bytesSource: 'estimated' },
    ],
    ...overrides,
  };
}

/** TASK-1060 — a host CPU summary: 64 GiB node, three services, a kernel remainder. */
export function makeCpu(overrides: Partial<ResidencyCpuSummary> = {}): ResidencyCpuSummary {
  return {
    source: 'prometheus',
    node: {
      label: 'dell — 48 vCPU',
      totalBytes: 64 * GiB,
      usedBytes: 24 * GiB,
      freeBytes: 40 * GiB,
      headroomPercent: 15,
      headroomBytes: 9.6 * GiB,
      overHeadroom: false,
      cpuCores: 48,
      utilisationPercent: 37,
    },
    services: [
      {
        service: 'nlp',
        label: 'Medical NLP',
        memoryBytes: 8 * GiB,
        memoryLimitBytes: 16 * GiB,
        cpuCores: 0.13,
        cpuRequestCores: 0.5,
        cpuLimitCores: 2,
        models: [
          { service: 'nlp', modelRef: 'gliner', name: 'GLiNER2', bytes: 3 * GiB, bytesSource: 'measured' },
          { service: 'nlp', modelRef: 'bert', name: 'Clinical BERT', bytes: 1 * GiB, bytesSource: 'estimated' },
          { service: 'nlp', modelRef: 'mystery', name: 'Mystery model', bytes: null, bytesSource: 'unknown' },
        ],
        attributedBytes: 4 * GiB,
        unattributedBytes: 4 * GiB,
      },
      {
        service: 'gateway',
        label: 'API gateway',
        memoryBytes: 2 * GiB,
        memoryLimitBytes: null,
        cpuCores: null,
        cpuRequestCores: null,
        cpuLimitCores: null,
        models: [],
        attributedBytes: 0,
        unattributedBytes: 0,
      },
      {
        service: 'other',
        label: 'Other workloads & system',
        memoryBytes: 6 * GiB,
        memoryLimitBytes: null,
        cpuCores: 1.5,
        cpuRequestCores: null,
        cpuLimitCores: null,
        models: [],
        attributedBytes: 0,
        unattributedBytes: 0,
      },
    ],
    unattributedBytes: 8 * GiB,
    ...overrides,
  };
}

/** A resident catalogue row: loaded on gpu0, measured, pinned by a live agent. */
export const LIVE_WHISPER = makeModel({
  aiModelId: '0199a1b2-0000-7000-8000-000000000001',
  name: 'ArcaAI Whisper ml-en',
  modelRef: 'whisper-ml-en',
  slug: 'whisper-ml-en',
  status: 'loaded',
  size: { bytes: 1.5 * GiB, source: 'measured' },
  identity: { matched: true, runtimeKeys: ['whisper-ml-en'], reportedKey: 'whisper-ml-en', candidates: [] },
  residency: {
    device: 'gpu0',
    instance: 'hope-stt-1',
    bytes: 1.5 * GiB,
    bytesSource: 'measured',
    inFlight: 2,
    requestsPerMin: 4.2,
    p50LatencyMs: 310,
    loadedAt: '2026-10-07T09:00:00Z',
    lastUsedAt: '2026-10-07T09:59:00Z',
  },
  usage: {
    agentCount: 5,
    tenantCount: 3,
    liveConsultation: true,
    uses: [
      {
        tenantId: '50000000-0000-0000-0000-000000000001',
        tenantName: 'ArcaAI',
        agentSlug: 'realtime-ml-en',
        agentName: 'Realtime (ml-en)',
        task: 'SPEECH_TO_TEXT',
        role: 'primary',
        liveConsultation: true,
      },
    ],
    consumers: { agents: 5, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
  },
  keepPolicy: {
    kind: 'always',
    label: 'Always loaded',
    reason: 'Used by a live-consultation agent',
    source: 'implicit-live-path',
    policyId: null,
    policyVersion: null,
    idleTtlSeconds: null,
  },
  actions: ['unload', 'edit_policy'],
});

/** Pinned for the live path but not resident. */
export const PINNED_NOT_LOADED = makeModel({
  aiModelId: '0199a1b2-0000-7000-8000-000000000002',
  name: 'Whisper Large Code-Switch',
  modelRef: 'whisper-large-cs',
  slug: 'whisper-large-cs',
  status: 'not_loaded',
  loadSeconds: 7,
  usage: {
    agentCount: 10,
    tenantCount: 4,
    liveConsultation: true,
    uses: [],
    consumers: { agents: 10, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
  },
  keepPolicy: { ...LIVE_WHISPER.keepPolicy },
  actions: ['load', 'edit_policy'],
});

export const REMOTE_SARVAM = makeModel({
  aiModelId: '0199a1b2-0000-7000-8000-000000000003',
  name: 'Sarvam Saaras v4',
  modelRef: 'sarvam-saaras-v4',
  slug: 'sarvam-saaras-v4',
  kind: 'remote',
  format: null,
  size: { bytes: null, source: 'unknown' },
  budgetBytes: null,
  keepPolicy: { ...LIVE_WHISPER.keepPolicy, kind: 'on_demand', label: 'Not applicable', reason: 'Cloud API — nothing to load', source: 'default' },
  actions: ['edit_policy'],
});

export const BUILTIN_RNNOISE = makeModel({
  aiModelId: '0199a1b2-0000-7000-8000-000000000004',
  name: 'RNNoise',
  modelRef: 'rnnoise',
  slug: 'rnnoise',
  kind: 'builtin',
  format: null,
  size: { bytes: null, source: 'unknown' },
  budgetBytes: null,
  actions: [],
});

/** LM Studio instance no catalogue row claims. */
export const UNMATCHED_GEMMA = makeModel({
  aiModelId: null,
  name: 'gemma-4-e2b-it-qat@q4_0',
  modelRef: 'gemma-4-e2b-it-qat@q4_0',
  slug: null,
  format: null,
  status: 'loaded',
  size: { bytes: 2.5 * GiB, source: 'measured' },
  identity: {
    matched: false,
    runtimeKeys: [],
    reportedKey: 'gemma-4-e2b-it-qat@q4_0',
    candidates: [
      {
        aiModelId: '0199a1b2-0000-7000-8000-000000000005',
        name: 'Gemma 4 E2B IT QAT',
        slug: 'lms-gemma-4-e2b',
        strength: 'strong',
        reason: 'Same key without @q4_0',
      },
    ],
  },
  residency: {
    device: 'gpu0',
    instance: 'lmstudio',
    bytes: 2.5 * GiB,
    bytesSource: 'measured',
    inFlight: 0,
    requestsPerMin: 31,
    p50LatencyMs: 1200,
    loadedAt: null,
    lastUsedAt: null,
  },
  actions: ['unload'],
});

export const ROUTING_GUARD = makeModel({
  aiModelId: '0199a1b2-0000-7000-8000-000000000006',
  name: 'Granite Guardian 4.1 8B',
  modelRef: 'granite-guardian',
  slug: 'granite-guardian-4.1-8b',
  status: 'loaded',
  size: { bytes: 4.9 * GiB, source: 'measured' },
  identity: { matched: true, runtimeKeys: ['granite-guardian'], reportedKey: 'granite-guardian', candidates: [] },
  residency: { ...LIVE_WHISPER.residency!, instance: 'lmstudio', inFlight: 0, requestsPerMin: null, p50LatencyMs: null, lastUsedAt: null },
  usage: {
    agentCount: 0,
    tenantCount: 3,
    liveConsultation: false,
    uses: [
      {
        tenantId: '00000000-0000-0000-0000-000000000000',
        tenantName: 'SYSTEM',
        agentSlug: null,
        agentName: null,
        task: 'guardrail.judge',
        role: 'routing',
        liveConsultation: false,
      },
    ],
    consumers: { agents: 0, fallbacks: 0, routingPolicies: 1, pipelineStages: 0, workflowNodes: 0 },
  },
  actions: ['unload', 'reload', 'edit_policy'],
});

export const FAILED_RNNOISE_LIKE = makeModel({
  aiModelId: '0199a1b2-0000-7000-8000-000000000007',
  name: 'Medical NER',
  modelRef: 'medical-ner',
  slug: 'medical-ner',
  status: 'failed',
  error: { code: 'ModelNotCacheServedError', message: 'weights missing', at: null },
  actions: ['load', 'edit_policy'],
});

export function makeService(overrides: Partial<ResidencyServiceGroup> = {}): ResidencyServiceGroup {
  return {
    service: 'stt',
    label: 'Speech-to-text — live sessions',
    runsOn: 'gpu',
    controllable: true,
    reachable: true,
    loadedCount: 0,
    models: [],
    ...overrides,
  };
}

export const STT = makeService({
  service: 'stt',
  label: 'Speech-to-text — live sessions',
  loadedCount: 1,
  models: [LIVE_WHISPER, PINNED_NOT_LOADED, REMOTE_SARVAM, BUILTIN_RNNOISE],
});
export const LMS = makeService({
  service: 'lm-studio',
  label: 'Language models (LM Studio)',
  loadedCount: 2,
  models: [ROUTING_GUARD, UNMATCHED_GEMMA],
});
export const NLP = makeService({ service: 'nlp', label: 'Medical NLP', loadedCount: 0, models: [FAILED_RNNOISE_LIKE] });
export const WORKER = makeService({
  service: 'stt-worker',
  label: 'Speech-to-text — background jobs',
  runsOn: 'cpu',
  controllable: false,
  loadedCount: 0,
  models: [],
});

export function makeSuggestion(overrides: Partial<ResidencySuggestion> = {}): ResidencySuggestion {
  return {
    id: 'sugg-1',
    at: '2026-10-07T09:59:00Z',
    firstSeenAt: '2026-10-07T08:00:00Z',
    repeats: 21,
    reason: 'live_path_pin',
    text: 'Load Whisper Large Code-Switch — pinned for 10 live ASR agents and not resident.',
    action: 'load',
    service: 'stt',
    modelRef: 'whisper-large-cs',
    applied: false,
    ...overrides,
  };
}

export function makeCatalogue(overrides: Partial<ModelResidencyCatalogueResponse> = {}): ModelResidencyCatalogueResponse {
  return {
    mode: 'shadow',
    reportedAt: '2026-10-07T10:00:00Z',
    freshness: { maxAgeSeconds: 4, staleServices: [], oldestReportAt: '2026-10-07T09:59:56Z' },
    devices: [makeDevice()],
    cpu: null,
    services: [STT, WORKER, LMS, NLP],
    suggestions: [makeSuggestion()],
    ...overrides,
  };
}

export { GiB };
