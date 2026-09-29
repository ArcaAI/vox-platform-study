import type {
  ModelResidencyCatalogueDevice,
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
  recommendations: ModelResidencyRecommendation[];
}

const SERVICE_META: Record<(typeof CATALOGUE_SERVICES)[number], { label: string; runsOn: CatalogueRunsOn }> = {
  stt: { label: 'Speech-to-text — live sessions', runsOn: 'gpu' },
  'stt-worker': { label: 'Speech-to-text — batch jobs', runsOn: 'gpu' },
  'lm-studio': { label: 'Language models (LM Studio)', runsOn: 'gpu' },
  nlp: { label: 'Medical NLP — entities and classification', runsOn: 'cpu' },
};

const STATUS_ORDER: Record<CatalogueModelStatus, number> = { loaded: 0, loading: 1, unloading: 2, failed: 3, not_loaded: 4 };
const SUGGESTION_LIMIT = 100;
const EMPTY_USAGE: ModelResidencyUsage = { agentCount: 0, tenantCount: 0, liveConsultation: false, uses: [] };

function isControlled(service: string): boolean {
  return (RESIDENCY_CONTROLLED_SERVICES as readonly string[]).includes(service);
}

export function buildResidencyCatalogue(input: CatalogueBuildInput): ModelResidencyCatalogueResponse {
  const groups = new Map<ResidencyServiceName, ModelResidencyCatalogueModel[]>(CATALOGUE_SERVICES.map((s) => [s, []]));
  const names = new Map<string, string>();
  const consumed = new Set<CatalogueResidentEntry>();
  const consumedFailures = new Set<CatalogueFailedEntry>();
  const catalogueById = new Map(input.catalogue.map((m) => [m.id, m]));

  // 1. Every catalogue model, under the workload that runs it.
  for (const model of input.catalogue) {
    const service = residencyServiceOf(model);
    if (!service || !groups.has(service)) continue;
    const modelRef = refFor(service, model);
    const entries = input.entries.filter(
      (e) => e.service === service && ((e.aiModelId !== null && e.aiModelId === model.id) || (modelRef !== null && e.modelRef === modelRef)),
    );
    for (const e of entries) consumed.add(e);
    const failures = input.failed.filter(
      (f) => f.service === service && ((f.aiModelId !== null && f.aiModelId === model.id) || (modelRef !== null && f.modelRef === modelRef)),
    );
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
      runsOn: SERVICE_META[service].runsOn,
      controllable: isControlled(service),
      // stt-worker sends no report: "reachable" is Prometheus answering at all (its residency is read from there).
      reachable: service === 'stt-worker' ? input.devices.some((d) => d.kind === 'gpu') : !input.staleServices.includes(service),
      loadedCount: models.filter((m) => m.status === 'loaded').length,
      models,
    };
  });

  const devices: ModelResidencyCatalogueDevice[] = input.devices.map((device) => {
    const seen = new Set<string>();
    const models = [];
    for (const e of input.entries) {
      const here = e.device === device.id || (e.device === 'multi' && device.kind === 'gpu');
      const key = residencyKey(e.service, e.modelRef);
      if (!here || seen.has(key)) continue;
      seen.add(key);
      models.push({
        service: e.service,
        modelRef: e.modelRef,
        name: nameOf(e.service, e.modelRef),
        // LM Studio splits one model over every card; its per-card share is not known.
        bytes: e.device === 'multi' || e.bytesSource !== 'measured' ? null : e.bytes,
      });
    }
    return {
      id: device.id,
      kind: device.kind,
      label: deviceLabel(device),
      totalBytes: device.totalBytes,
      usedBytes: device.usedBytes,
      freeBytes: device.freeBytes,
      utilisationPercent: device.utilisationPercent,
      headroomPercent: input.headroomPercent,
      models,
    };
  });

  const suggestions: ModelResidencySuggestion[] = input.recommendations.slice(0, SUGGESTION_LIMIT).map((r) => {
    const entry = input.entries.find((e) => e.service === r.service && e.modelRef === r.modelRef);
    const lastUsed = entry?.lastUsedAt ? Date.parse(entry.lastUsedAt) : NaN;
    const idleMinutes = Number.isFinite(lastUsed) ? Math.max(1, Math.round((input.now - lastUsed) / 60_000)) : null;
    return {
      id: r.id,
      at: r.at,
      text: suggestionText(r, nameOf(r.service, r.modelRef), idleMinutes),
      action: r.action,
      service: r.service,
      modelRef: r.modelRef,
      applied: r.applied,
    };
  });

  return { mode: input.mode, reportedAt: input.reportedAt, freshness: input.freshness, devices, services, suggestions };
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
      }
    : null;

  const cls = input.classify(service, modelRef ?? '', aiModelId);
  return {
    aiModelId,
    name: model?.name ?? primary?.aiModelName ?? failure?.aiModelName ?? modelRef ?? 'Unnamed model',
    slug: model?.slug ?? null,
    modelRef,
    format: model?.format ?? null,
    status,
    error: status === 'failed' && failure ? { ...failure.error } : null,
    size,
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
