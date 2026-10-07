import type {
  ModelResidencyLoadPreview,
  ModelResidencyReadiness,
  ResidencyCatalogueModel,
  ResidencyDevice,
  ResidencyServiceGroup,
} from '../../api/types';

export const GIB = 1024 ** 3;

export const DEVICE: ResidencyDevice = {
  id: 'gpu0',
  kind: 'gpu',
  label: 'GPU 0 — NVIDIA RTX 2000 Ada Generation',
  totalBytes: 16 * GIB,
  usedBytes: 15 * GIB,
  freeBytes: 1 * GIB,
  utilisationPercent: 2,
  headroomPercent: 15,
  headroomBytes: 2.4 * GIB,
  overHeadroom: true,
  attributedBytes: 9 * GIB,
  unattributedBytes: 6 * GIB,
  models: [],
};

export function makeModel(overrides: Partial<ResidencyCatalogueModel> = {}): ResidencyCatalogueModel {
  return {
    aiModelId: '0199a1b2-0000-7000-8000-000000000001',
    name: 'Whisper Large',
    kind: 'resident',
    slug: 'whisper-large',
    modelRef: 'whisper-large-gguf',
    format: 'GGUF',
    status: 'not_loaded',
    size: { bytes: 1.7 * GIB, source: 'catalogue' },
    budgetBytes: 2 * GIB,
    identity: { matched: true, runtimeKeys: ['whisper-large-gguf'], reportedKey: null, candidates: [] },
    loadSeconds: 18,
    residency: null,
    usage: {
      agentCount: 2,
      tenantCount: 1,
      liveConsultation: false,
      uses: [],
      consumers: { agents: 2, fallbacks: 0, routingPolicies: 0, pipelineStages: 3, workflowNodes: 4 },
    },
    keepPolicy: {
      kind: 'on_demand',
      label: 'Load when needed',
      reason: 'Default',
      source: 'default',
      policyId: null,
      policyVersion: null,
      idleTtlSeconds: null,
    },
    actions: ['load', 'edit_policy'],
    ...overrides,
  };
}

export function makeLoaded(overrides: Partial<ResidencyCatalogueModel> = {}): ResidencyCatalogueModel {
  return makeModel({
    status: 'loaded',
    actions: ['unload', 'edit_policy'],
    residency: {
      device: 'gpu0',
      instance: 'i-1',
      bytes: 1.7 * GIB,
      bytesSource: 'measured',
      inFlight: 0,
      requestsPerMin: 3,
      p50LatencyMs: 300,
      loadedAt: '2026-10-06T11:54:00Z',
      lastUsedAt: '2026-10-06T11:55:00Z',
    },
    ...overrides,
  });
}

export function makeService(model: ResidencyCatalogueModel, overrides: Partial<ResidencyServiceGroup> = {}): ResidencyServiceGroup {
  return {
    service: 'stt',
    label: 'Speech-to-text — live sessions',
    runsOn: 'gpu',
    controllable: true,
    reachable: true,
    loadedCount: 1,
    models: [model],
    ...overrides,
  };
}

export function makePreview(overrides: Partial<ModelResidencyLoadPreview> = {}): ModelResidencyLoadPreview {
  return {
    service: 'stt',
    modelRef: 'whisper-large-gguf',
    device: 'gpu0',
    needBytes: 2 * GIB,
    needSource: 'catalogue',
    freeBytes: 1 * GIB,
    headroomBytes: 2.4 * GIB,
    unattributedBytes: 6 * GIB,
    shortfallBytes: 3.4 * GIB,
    fits: false,
    refusal: 'OVER_BUDGET',
    evictable: [
      { service: 'nlp', modelRef: 'medical-ner', name: 'Medical NER', bytes: 0.8 * GIB, reason: 'On demand · idle 5 h' },
      { service: 'nlp', modelRef: 'big-one', name: 'Big One', bytes: 4 * GIB, reason: 'On demand' },
    ],
    pinned: [{ service: 'stt', modelRef: 'radiology-asr-en', name: 'Radiology ASR', bytes: 2 * GIB, reason: 'Used by a live-consultation agent' }],
    ...overrides,
  };
}

export function makeReadiness(overrides: Partial<ModelResidencyReadiness> = {}): ModelResidencyReadiness {
  return {
    mode: 'shadow',
    passed: 1,
    total: 2,
    checks: [
      { id: 'shadow_review_recorded', title: 'Shadow review recorded', passed: false, detail: 'No review on file.' },
      { id: 'shadow_days', title: 'Seven days of shadow data', passed: true, detail: '12 days since 25 Sep.' },
    ],
    shadow: { since: '2026-10-06T11:54:00Z', loads: 41, unloads: 37, refusedOverBudget: 3, duplicateLoads: 21 },
    ...overrides,
  };
}
