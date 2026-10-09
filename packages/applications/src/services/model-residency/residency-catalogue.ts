import type {
  ModelResidencyDeviceShare,
  ModelResidencyLoadConfig,
  ModelResidencyCatalogueDevice,
  ModelResidencyIdentity,
  ModelResidencyCatalogueModel,
  ModelResidencyCatalogueResponse,
  ModelResidencyCatalogueService,
  ModelResidencyDevice,
  ModelResidencyFreshness,
  ModelResidencyKeepPolicy,
  ModelResidencyRecommendation,
  ModelResidencySize,
  ModelResidencySuggestion,
  ModelResidencyUsage,
} from './dto';
import {
  type CatalogueAction,
  type CatalogueDeviceBytesSource,
  type CatalogueModelKind,
  type CatalogueModelStatus,
  type CatalogueRefFields,
  type CatalogueRunsOn,
  type ResidencyBytesSource,
  type ResidencyClassName,
  type ResidencyClassSource,
  type ResidencyLoadError,
  type ResidencyMode,
  type ResidencyModelState,
  type ResidencyServiceName,
  type ServingIdentity,
  CATALOGUE_SERVICES,
  RESIDENCY_CONTROLLED_SERVICES,
  refFor,
  residencyKey,
  residencyServiceOf,
} from './model-residency.types';
import { budgetFor } from './residency-budget';
import { rankRuntimeKeyCandidates, resolveRuntimeKey, runtimeKeysFor } from './runtime-key';
import type { ModelResidencyUsageIndex } from './model-usage-index';

/**
 * TASK-1005 §13 — the CATALOGUE-FIRST residency view, as a pure function of
 * what the controller already knows (owner review 2026-09-25: "I don't know
 * which model will be loaded and handled by what service").
 *
 * `GET admin/model-residency` lists only what is resident. This lists every
 * SELF_HOSTED catalogue model under the workload that runs it (`servedBy`,
 * normalised by `residencyServiceOf`), loaded or not, and merges onto each row
 * what the ledger says about it right now. A resident model the catalogue does
 * not know is still listed — it holds memory — with `aiModelId: null`.
 *
 * Every word the console shows (labels, keep-policy reasons, suggestion
 * sentences) is decided HERE, so the console renders and never re-derives.
 * Pinned by `tests/contracts/model-residency-catalogue.fixture.json`.
 */

const MiB = 1024 * 1024;

/** The catalogue fields the view reads. `AiModelEntity` satisfies it. */
export interface CatalogueModelRow extends ServingIdentity, CatalogueRefFields {
  id: string;
  name: string;
  format: string;
  /** TASK-1051 F3 — `AiModel.libraryName`: names a library that compiles the model in, or a cloud engine. */
  libraryName?: string | null;
  memorySizeMb?: number | null;
  observedMemoryMb?: number | null;
  observedLoadSeconds?: number | null;
}

/** The slice of a ledger entry the view reads (one resident instance). */
export interface CatalogueResidentEntry {
  service: ResidencyServiceName;
  instance: string;
  modelRef: string;
  aiModelId: string | null;
  aiModelName: string | null;
  device: string;
  state: ResidencyModelState;
  bytes: number | null;
  bytesSource: ResidencyBytesSource;
  inFlight: number | null;
  requestsPerMin: number | null;
  p50LatencyMs: number | null;
  loadedAt: string | null;
  lastUsedAt: string | null;
  loadSeconds: number | null;
  ttlSeconds: number | null;
  adminPinned: boolean;
  /** TASK-1055 — bytes per card (`gpu<N>`), as the service measured them; a split model's real per-card footprint. */
  deviceBytes?: ModelResidencyDeviceShare[];
  /** TASK-1055 — LM Studio: the config the instance was actually loaded with. */
  loadConfig?: ModelResidencyLoadConfig | null;
}

/** A model whose last load FAILED (TASK-1019): it holds no memory, so it is not an entry. */
export interface CatalogueFailedEntry {
  service: ResidencyServiceName;
  modelRef: string;
  aiModelId: string | null;
  aiModelName: string | null;
  error: ResidencyLoadError;
}

export interface CatalogueClassification {
  class: ResidencyClassName;
  classSource: ResidencyClassSource;
  policy: { id: string; version: number; idleTtlSeconds?: number | null } | null;
}

export interface CatalogueBuildInput {
  now: number;
  mode: ResidencyMode;
  reportedAt: string;
  freshness: ModelResidencyFreshness;
  headroomPercent: number;
  devices: Array<Omit<ModelResidencyDevice, 'headroomPercent'>>;
  staleServices: string[];
  entries: CatalogueResidentEntry[];
  /** Models whose last load failed and nothing has cleared. A resident entry or a running load outranks one. */
  failed: CatalogueFailedEntry[];
  /** Admitted loads still running (a `loading` row even before the service reports it). */
  loading: Array<{ service: string; modelRef: string }>;
  /** SYSTEM, SELF_HOSTED, not DELETED. Rows no residency workload runs are skipped. */
  catalogue: CatalogueModelRow[];
  /** A catalogue row by id outside `catalogue` (the ledger's own lookup) — for a resident model's name. */
  modelById(aiModelId: string): CatalogueModelRow | undefined;
  usage: ModelResidencyUsageIndex;
  classify(service: string, modelRef: string, aiModelId: string | null): CatalogueClassification;
  /** A MEASURED footprint when not resident (LM Studio's own measurement, else `observedMemoryMb`). */
  observedBytes(service: string, modelRef: string, model: CatalogueModelRow | undefined): number | undefined;
  observedLoadSeconds(service: string, modelRef: string, model: CatalogueModelRow | undefined): number | null;
  /** Standing, non-dismissed recommendations (TASK-1051 F4); `firstSeenAt` / `repeats` fall back to `at` / 1 when absent. */
  recommendations: Array<
    Omit<ModelResidencyRecommendation, 'firstSeenAt' | 'repeats'> & Partial<Pick<ModelResidencyRecommendation, 'firstSeenAt' | 'repeats'>>
  >;
}

const SERVICE_META: Record<(typeof CATALOGUE_SERVICES)[number], { label: string; runsOn: CatalogueRunsOn }> = {
  stt: { label: 'Speech-to-text — live sessions', runsOn: 'gpu' },
  'stt-worker': { label: 'Speech-to-text — batch jobs', runsOn: 'gpu' },
  'lm-studio': { label: 'Language models (LM Studio)', runsOn: 'gpu' },
  nlp: { label: 'Medical NLP — entities and classification', runsOn: 'cpu' },
};

const STATUS_ORDER: Record<CatalogueModelStatus, number> = { loaded: 0, loading: 1, unloading: 2, failed: 3, not_loaded: 4 };
const SUGGESTION_LIMIT = 20;
const EMPTY_USAGE: ModelResidencyUsage = {
  agentCount: 0,
  tenantCount: 0,
  liveConsultation: false,
  uses: [],
  consumers: { agents: 0, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
};

/** Libraries that compile the model into themselves: nothing for HOPE to load (lower-case). */
const BUILTIN_LIBRARIES: ReadonlySet<string> = new Set(['pyrnnoise']);
/** Cloud API engines (matched against library, provider and format, lower-case): nothing resident. */
const REMOTE_ENGINES: ReadonlySet<string> = new Set(['sarvam', 'azure', 'deepgram', 'openai', 'elevenlabs']);
const BUILTIN_FAILURE_CODE = 'ModelNotCacheServedError';
const REMOTE_FAILURE_PREFIX = 'CloudASR';

function modelKind(model: CatalogueModelRow | undefined, entries: CatalogueResidentEntry[], failure?: CatalogueFailedEntry): CatalogueModelKind {
  if (entries.length > 0) return 'resident';
  const library = model?.libraryName?.toLowerCase();
  if ((library && BUILTIN_LIBRARIES.has(library)) || failure?.error.code === BUILTIN_FAILURE_CODE) return 'builtin';
  const engines = [model?.libraryName, model?.provider, model?.format].map((v) => v?.toLowerCase());
  if (engines.some((v) => v && REMOTE_ENGINES.has(v)) || failure?.error.code.startsWith(REMOTE_FAILURE_PREFIX)) return 'remote';
  return 'resident';
}

const onGpu = (device: string): boolean => device.startsWith('gpu') || device === 'multi' || device.startsWith('cuda');

function isControlled(service: string): boolean {
  return (RESIDENCY_CONTROLLED_SERVICES as readonly string[]).includes(service);
}

export function buildResidencyCatalogue(input: CatalogueBuildInput): ModelResidencyCatalogueResponse {
  const groups = new Map<ResidencyServiceName, ModelResidencyCatalogueModel[]>(CATALOGUE_SERVICES.map((s) => [s, []]));
  const names = new Map<string, string>();
  const consumed = new Set<CatalogueResidentEntry>();
  const consumedFailures = new Set<CatalogueFailedEntry>();
  const catalogueById = new Map(input.catalogue.map((m) => [m.id, m]));
  const entryModel = new Map<CatalogueResidentEntry, CatalogueModelRow | undefined>();

  // Rows per service — a reported key resolves among its own service's rows only (exact → confirmed → unique normalised).
  const rowsByService = new Map<ResidencyServiceName, CatalogueModelRow[]>();
  for (const m of input.catalogue) {
    const s = residencyServiceOf(m);
    if (s) rowsByService.set(s, [...(rowsByService.get(s) ?? []), m]);
  }

  // 1. Every catalogue model, under the workload that runs it.
  for (const model of input.catalogue) {
    const service = residencyServiceOf(model);
    if (!service || !groups.has(service)) continue;
    const modelRef = refFor(service, model);
    const claims = (r: { aiModelId: string | null; modelRef: string }): boolean =>
      r.aiModelId !== null ? r.aiModelId === model.id : resolveRuntimeKey(service, r.modelRef, rowsByService.get(service) ?? [])?.row.id === model.id;
    const entries = input.entries.filter((e) => e.service === service && claims(e));
    for (const e of entries) {
      consumed.add(e);
      entryModel.set(e, model);
    }
    const failures = input.failed.filter((f) => f.service === service && claims(f));
    for (const f of failures) consumedFailures.add(f);
    const ref = modelRef ?? entries[0]?.modelRef ?? failures[0]?.modelRef ?? null;
    if (ref) names.set(residencyKey(service, ref), model.name);
    groups.get(service)!.push(modelRow(input, service, model, ref, entries, failures[0]));
  }

  // 2. Resident models no row above claimed (served elsewhere per the catalogue, or unknown to it) — they hold memory.
  const extras = new Map<string, CatalogueResidentEntry[]>();
  for (const e of input.entries) {
    if (consumed.has(e) || !groups.has(e.service)) continue;
    const key = residencyKey(e.service, e.modelRef);
    extras.set(key, [...(extras.get(key) ?? []), e]);
  }
  for (const entries of extras.values()) {
    const { service, modelRef, aiModelId } = entries[0];
    const model = aiModelId ? (catalogueById.get(aiModelId) ?? input.modelById(aiModelId)) : undefined;
    if (model || entries[0].aiModelName) names.set(residencyKey(service, modelRef), model?.name ?? entries[0].aiModelName!);
    for (const e of entries) entryModel.set(e, model);
    groups.get(service)!.push(modelRow(input, service, model, modelRef, entries));
  }

  // 2b. A failed load no row above claimed — a model the catalogue does not know still shows WHY it is not serving.
  for (const failure of input.failed) {
    const rows = groups.get(failure.service);
    if (consumedFailures.has(failure) || !rows || rows.some((r) => r.modelRef === failure.modelRef)) continue;
    const model = failure.aiModelId ? (catalogueById.get(failure.aiModelId) ?? input.modelById(failure.aiModelId)) : undefined;
    if (model || failure.aiModelName) names.set(residencyKey(failure.service, failure.modelRef), model?.name ?? failure.aiModelName!);
    rows.push(modelRow(input, failure.service, model, failure.modelRef, [], failure));
  }

  // 3. An admitted load the service has not reported yet, of a model no row names.
  for (const op of input.loading) {
    const service = op.service as ResidencyServiceName;
    const rows = groups.get(service);
    if (!rows || rows.some((r) => r.modelRef === op.modelRef)) continue;
    rows.push(modelRow(input, service, undefined, op.modelRef, []));
  }

  const nameOf = (service: string, modelRef: string): string => names.get(residencyKey(service, modelRef)) ?? modelRef;

  const services: ModelResidencyCatalogueService[] = CATALOGUE_SERVICES.map((service) => {
    const models = groups.get(service)!.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));
    return {
      service,
      label: SERVICE_META[service].label,
      runsOn: runsOnFor(service, input.entries),
      controllable: isControlled(service),
      // stt-worker sends no report: "reachable" is Prometheus answering at all (its residency is read from there).
      reachable: service === 'stt-worker' ? input.devices.some((d) => d.kind === 'gpu') : !input.staleServices.includes(service),
      loadedCount: models.filter((m) => m.status === 'loaded').length,
      models,
    };
  });

  const footprintOf = (e: CatalogueResidentEntry): ResidencyFootprint | null => {
    const model = entryModel.get(e);
    return footprintFor(e, input.observedBytes(e.service, e.modelRef, model), model?.memorySizeMb);
  };
  const gpuDevices = input.devices.filter((d) => d.kind === 'gpu');

  const devices: ModelResidencyCatalogueDevice[] = input.devices.map((device) => {
    const attribution = attributeDevice(device, input.entries, gpuDevices, footprintOf);
    const models: ModelResidencyCatalogueDevice['models'] = attribution.models.map(({ entry: e, bytes, bytesSource }) => ({
      service: e.service,
      modelRef: e.modelRef,
      name: nameOf(e.service, e.modelRef),
      bytes,
      bytesSource,
    }));
    const headroomBytes = Math.floor((device.totalBytes * input.headroomPercent) / 100);
    return {
      id: device.id,
      kind: device.kind,
      label: deviceLabel(device),
      totalBytes: device.totalBytes,
      usedBytes: device.usedBytes,
      freeBytes: device.freeBytes,
      utilisationPercent: device.utilisationPercent,
      headroomPercent: input.headroomPercent,
      headroomBytes,
      overHeadroom: device.freeBytes < headroomBytes,
      attributedBytes: attribution.attributedBytes,
      unattributedBytes: attribution.unattributedBytes,
      models,
    };
  });

  // Standing recommendations: only the most recently confirmed one per (action, service, model).
  const latest = new Map<string, CatalogueBuildInput['recommendations'][number]>();
  for (const r of input.recommendations) {
    const key = `${r.action}|${r.service}|${r.modelRef}`;
    const kept = latest.get(key);
    if (!kept || Date.parse(r.at) > Date.parse(kept.at)) latest.set(key, r);
  }
  const suggestions: ModelResidencySuggestion[] = [...latest.values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, SUGGESTION_LIMIT)
    .map((r) => {
      const entry = input.entries.find((e) => e.service === r.service && e.modelRef === r.modelRef);
      const lastUsed = entry?.lastUsedAt ? Date.parse(entry.lastUsedAt) : NaN;
      const idleMinutes = Number.isFinite(lastUsed) ? Math.max(1, Math.round((input.now - lastUsed) / 60_000)) : null;
      return {
        id: r.id,
        at: r.at,
        firstSeenAt: r.firstSeenAt ?? r.at,
        repeats: r.repeats ?? 1,
        reason: r.reason,
        text: suggestionText(r, nameOf(r.service, r.modelRef), idleMinutes),
        action: r.action,
        service: r.service,
        modelRef: r.modelRef,
        applied: r.applied,
      };
    });

  return { mode: input.mode, reportedAt: input.reportedAt, freshness: input.freshness, devices, services, suggestions };
}

/** A resident instance's whole footprint and how it is known. */
export interface ResidencyFootprint {
  bytes: number;
  source: CatalogueDeviceBytesSource;
}

/** The slice of an entry per-device attribution reads. */
export interface AttributableEntry {
  service: string;
  modelRef: string;
  device: string;
  bytes: number | null;
  bytesSource: ResidencyBytesSource;
  deviceBytes?: ModelResidencyDeviceShare[];
}

/**
 * The ONE footprint rule for a resident instance (catalogue and admission preview, TASK-1055):
 * its reported bytes (`measured` stays measured; anything else is an estimate), else the model's
 * observed size, else its catalogue size — both estimates for an instance that reports none.
 */
export function footprintFor(
  entry: Pick<AttributableEntry, 'bytes' | 'bytesSource'>,
  observedBytes: number | null | undefined,
  memorySizeMb: number | null | undefined,
): ResidencyFootprint | null {
  if (entry.bytes !== null && entry.bytes > 0) return { bytes: entry.bytes, source: entry.bytesSource === 'measured' ? 'measured' : 'estimated' };
  if (observedBytes) return { bytes: observedBytes, source: 'estimated' };
  if (memorySizeMb) return { bytes: memorySizeMb * MiB, source: 'estimated' };
  return null;
}

/**
 * TASK-1055 — what each resident instance holds on ONE device, and the ONE unattributed formula
 * the catalogue and the admission preview share: `device.usedBytes − Σ per-device bytes of every
 * instance on it`, floored at 0.
 *
 * Per-device bytes come from the service's own per-card measurement (`deviceBytes`) when it sent
 * one — an instance is then "on" exactly the cards it names. Without it: the whole footprint on
 * the instance's device, and an LM Studio `multi` instance's footprint split in proportion to each
 * card's used bytes (estimated; the TASK-1051 fallback for an agent that predates per-card bytes).
 */
export function attributeDevice<E extends AttributableEntry>(
  device: { id: string; kind: 'gpu' | 'cpu'; usedBytes: number },
  entries: readonly E[],
  gpuDevices: ReadonlyArray<{ id: string; usedBytes: number }>,
  footprintOf: (entry: E) => ResidencyFootprint | null,
): {
  models: Array<{ entry: E; bytes: number | null; bytesSource: CatalogueDeviceBytesSource }>;
  attributedBytes: number;
  unattributedBytes: number;
} {
  const splitShare = (footprint: number): number => {
    const usedTotal = gpuDevices.reduce((sum, d) => sum + d.usedBytes, 0);
    const weight = (d: { usedBytes: number }): number => (usedTotal > 0 ? d.usedBytes / usedTotal : 1 / gpuDevices.length);
    let allocated = 0;
    for (let i = 0; i < gpuDevices.length; i++) {
      const share = i === gpuDevices.length - 1 ? footprint - allocated : Math.floor(footprint * weight(gpuDevices[i]));
      if (gpuDevices[i].id === device.id) return share;
      allocated += share;
    }
    return 0;
  };
  const seen = new Set<string>();
  const models: Array<{ entry: E; bytes: number | null; bytesSource: CatalogueDeviceBytesSource }> = [];
  for (const e of entries) {
    const key = residencyKey(e.service, e.modelRef);
    const share = e.deviceBytes?.find((d) => d.device === device.id);
    const multi = !e.deviceBytes?.length && e.device === 'multi' && device.kind === 'gpu';
    const here = e.deviceBytes?.length ? share !== undefined : e.device === device.id || multi;
    if (!here || seen.has(key)) continue;
    seen.add(key);
    if (share) {
      models.push({ entry: e, bytes: share.bytes, bytesSource: e.bytesSource === 'measured' ? 'measured' : 'estimated' });
      continue;
    }
    const footprint = footprintOf(e);
    if (!footprint) models.push({ entry: e, bytes: null, bytesSource: 'unknown' });
    else models.push({ entry: e, bytes: multi ? splitShare(footprint.bytes) : footprint.bytes, bytesSource: multi ? 'estimated' : footprint.source });
  }
  const attributedBytes = models.reduce((sum, m) => sum + (m.bytes ?? 0), 0);
  return { models, attributedBytes, unattributedBytes: Math.max(0, Math.round(device.usedBytes - attributedBytes)) };
}

/** Where the service actually runs: any GPU-placed instance → gpu; instances all on CPU → cpu; nothing resident → the static default. */
function runsOnFor(service: ResidencyServiceName, entries: CatalogueResidentEntry[]): CatalogueRunsOn {
  const mine = entries.filter((e) => e.service === service);
  if (mine.some((e) => onGpu(e.device))) return 'gpu';
  return mine.length > 0 ? 'cpu' : SERVICE_META[service].runsOn;
}

function modelRow(
  input: CatalogueBuildInput,
  service: ResidencyServiceName,
  model: CatalogueModelRow | undefined,
  modelRef: string | null,
  entries: CatalogueResidentEntry[],
  failure?: CatalogueFailedEntry,
): ModelResidencyCatalogueModel {
  const primary = entries[0];
  const loading = modelRef !== null && input.loading.some((op) => op.service === service && op.modelRef === modelRef);
  // A resident instance or a load in progress outranks an old failure: the failure is only news while nothing else is going on.
  const status: CatalogueModelStatus = primary ? primary.state : loading ? 'loading' : failure ? 'failed' : 'not_loaded';
  const aiModelId = model?.id ?? primary?.aiModelId ?? failure?.aiModelId ?? null;

  const measuredEntries = entries.filter((e) => e.bytesSource === 'measured' && e.bytes !== null);
  const residentBytes =
    entries.length > 0 && measuredEntries.length === entries.length ? measuredEntries.reduce((sum, e) => sum + e.bytes!, 0) : null;
  const observed = modelRef !== null ? input.observedBytes(service, modelRef, model) : undefined;
  let size: ModelResidencySize;
  if (residentBytes !== null) size = { bytes: residentBytes, source: 'measured' };
  else if (observed) size = { bytes: observed, source: 'measured' };
  else if (model?.memorySizeMb) size = { bytes: model.memorySizeMb * MiB, source: 'catalogue' };
  else size = { bytes: null, source: 'unknown' };

  const inFlight = entries.some((e) => e.inFlight !== null) ? entries.reduce((sum, e) => sum + (e.inFlight ?? 0), 0) : null;
  const residency = primary
    ? {
        device: primary.device,
        instance: primary.instance,
        bytes: residentBytes,
        bytesSource: residentBytes !== null ? ('measured' as const) : ('unknown' as const),
        inFlight,
        requestsPerMin: primary.requestsPerMin,
        p50LatencyMs: primary.p50LatencyMs,
        loadedAt: primary.loadedAt,
        lastUsedAt: primary.lastUsedAt,
        ...(primary.deviceBytes ? { deviceBytes: primary.deviceBytes.map((d) => ({ ...d })) } : {}),
        ...(primary.loadConfig !== undefined ? { loadConfig: primary.loadConfig ? { ...primary.loadConfig } : null } : {}),
      }
    : null;

  const cls = input.classify(service, modelRef ?? '', aiModelId);
  const kind = modelKind(model, entries, failure);
  const identity = identityFor(input, service, model, modelRef, primary);
  if (kind !== 'resident') {
    const reason =
      kind === 'remote' ? 'Cloud API — nothing to hold in memory' : `Built into ${model?.libraryName ?? 'its library'} — nothing to load`;
    return {
      aiModelId,
      name: model?.name ?? failure?.aiModelName ?? modelRef ?? 'Unnamed model',
      kind,
      slug: model?.slug ?? null,
      modelRef,
      format: model?.format ?? null,
      status: 'not_loaded',
      error: null,
      size,
      budgetBytes: null,
      identity,
      loadSeconds: null,
      residency: null,
      usage: aiModelId ? input.usage.get(aiModelId) : EMPTY_USAGE,
      keepPolicy: {
        kind: 'on_demand',
        label: 'Not applicable',
        reason,
        source: 'default',
        policyId: null,
        policyVersion: null,
        idleTtlSeconds: null,
      },
      actions: [],
    };
  }
  return {
    aiModelId,
    name: model?.name ?? primary?.aiModelName ?? failure?.aiModelName ?? modelRef ?? 'Unnamed model',
    kind,
    slug: model?.slug ?? null,
    modelRef,
    format: model?.format ?? null,
    status,
    error: status === 'failed' && failure ? { ...failure.error } : null,
    size,
    budgetBytes: budgetFor(size.source === 'measured' ? size.bytes : null, model?.memorySizeMb).bytes,
    identity,
    loadSeconds: primary?.loadSeconds ?? (modelRef !== null ? input.observedLoadSeconds(service, modelRef, model) : null) ?? null,
    residency,
    usage: aiModelId ? input.usage.get(aiModelId) : EMPTY_USAGE,
    keepPolicy: keepPolicyFor(
      cls,
      primary?.ttlSeconds ?? null,
      entries.some((e) => e.adminPinned),
    ),
    actions: actionsFor(service, status, modelRef, aiModelId),
  };
}

/** Whether the reported instance is tied to a catalogue row, and if not, which rows it could be. */
function identityFor(
  input: CatalogueBuildInput,
  service: ResidencyServiceName,
  model: CatalogueModelRow | undefined,
  modelRef: string | null,
  primary: CatalogueResidentEntry | undefined,
): ModelResidencyIdentity {
  if (model) return { matched: true, runtimeKeys: runtimeKeysFor(service, model), reportedKey: primary?.modelRef ?? null, candidates: [] };
  const rows = input.catalogue.filter((m) => residencyServiceOf(m) === service);
  return {
    matched: false,
    runtimeKeys: [],
    reportedKey: primary?.modelRef ?? null,
    candidates: modelRef ? rankRuntimeKeyCandidates(service, modelRef, rows) : [],
  };
}

/**
 * The residency class in plain words: PINNED → "Always loaded", WARM → "Keep
 * warm", ON_DEMAND → "Load when needed", with WHY. An always-loaded model has
 * no idle TTL; otherwise the TTL is the policy's, else the service's own.
 */
export function keepPolicyFor(cls: CatalogueClassification, serviceTtlSeconds: number | null, operatorPinned: boolean): ModelResidencyKeepPolicy {
  const policyId = cls.policy?.id ?? null;
  const policyVersion = cls.policy?.version ?? null;
  const ttl = cls.policy?.idleTtlSeconds ?? serviceTtlSeconds ?? null;
  if (cls.class === 'PINNED') {
    const reason = cls.classSource === 'implicit-live-path' ? 'Used by a live-consultation agent' : 'Pinned by a residency policy';
    return { kind: 'always', label: 'Always loaded', reason, source: cls.classSource, policyId, policyVersion, idleTtlSeconds: null };
  }
  const pinNote = operatorPinned ? ' — an operator has pinned it on the running service for now' : '';
  if (cls.class === 'WARM') {
    return {
      kind: 'warm',
      label: 'Keep warm',
      reason: `Kept loaded while it is in regular use (residency policy)${pinNote}`,
      source: cls.classSource,
      policyId,
      policyVersion,
      idleTtlSeconds: ttl,
    };
  }
  const reason = cls.classSource === 'policy' ? 'Set by a residency policy' : 'Default for models no live agent uses';
  return {
    kind: 'on_demand',
    label: 'Load when needed',
    reason: `${reason}${pinNote}`,
    source: cls.classSource,
    policyId,
    policyVersion,
    idleTtlSeconds: ttl,
  };
}

/**
 * What the console may offer for a row now. stt-worker is observed, never
 * commanded; a row with no `modelRef` cannot be named to its service; a
 * policy needs a catalogue id. `unload` stays offered while requests are in
 * flight (the API answers 409 IN_FLIGHT and the console asks for force + reason);
 * `reload` (replace) is offered for LM Studio, whose load options change the instance.
 */
export function actionsFor(service: string, status: CatalogueModelStatus, modelRef: string | null, aiModelId: string | null): CatalogueAction[] {
  const actions: CatalogueAction[] = [];
  if (isControlled(service) && modelRef !== null) {
    if (status === 'not_loaded' || status === 'failed') actions.push('load');
    else if (status === 'loaded') {
      actions.push('unload');
      if (service === 'lm-studio') actions.push('reload');
    }
  }
  if (aiModelId) actions.push('edit_policy');
  return actions;
}

/** One plain sentence per shadow-mode (or enforce-mode) recommendation. */
export function suggestionText(
  r: Pick<ModelResidencyRecommendation, 'action' | 'reason' | 'service'>,
  name: string,
  idleMinutes: number | null,
): string {
  const on = `${name} on ${r.service}`;
  switch (`${r.action}:${r.reason}`) {
    case 'unload:idle_ttl_expired':
      return idleMinutes !== null
        ? `Unload ${on} — idle for ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'} and no live agent uses it.`
        : `Unload ${on} — idle longer than its keep time and no live agent uses it.`;
    case 'unload:make_room':
      return `Unload ${on} to make room for a model that has to be loaded.`;
    case 'load:live_path_pin':
      return `Load ${on} — a live-consultation agent uses it and it is not loaded.`;
    case 'load:promotion_rate':
      return `Load ${on} — it has been busy enough to keep warm.`;
    case 'load:admission_rejected':
      return `${name} cannot be loaded on ${r.service} — not enough free memory, even after unloading idle models.`;
    case 'pin:live_path_pin':
      return `Keep ${on} always loaded — a live-consultation agent uses it.`;
    case 'unpin:live_path_pin':
      return `Stop keeping ${on} always loaded — no live-consultation agent uses it any more.`;
    default:
      return `${r.action.charAt(0).toUpperCase()}${r.action.slice(1)} ${on}.`;
  }
}

function deviceLabel(device: Omit<ModelResidencyDevice, 'headroomPercent'>): string {
  if (device.kind === 'gpu' && device.id.startsWith('gpu')) return `GPU ${device.id.slice(3)} — ${device.name}`;
  if (device.id.startsWith('cpu:')) return `Host memory — ${device.id.slice(4)}`;
  return device.name;
}
