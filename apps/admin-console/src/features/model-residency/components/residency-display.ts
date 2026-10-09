/**
 * TASK-1005 §13 L-RUI / TASK-1051 lane C1 — plain-language rendering helpers
 * for the catalogue screen. Pure functions (no JSX) so the "no raw enums"
 * contract is testable in isolation from the component tree: `status`,
 * `keepPolicy.kind`, `kind`, device ids and the `PINNED`/`WARM`/`ON_DEMAND`
 * write-side class never reach the DOM directly — everything here builds a
 * sentence instead. Estimates are always marked as estimates (`~… est.`).
 */

import { formatBytes, formatRelativeTime } from '@/shared/format';
import type {
  ModelResidencyCatalogueResponse,
  ResidencyAction,
  ResidencyCatalogueModel,
  ResidencyDevice,
  ResidencyKeepPolicyKind,
  ResidencyPolicyClass,
  ResidencyServiceGroup,
  ResidencyUsage,
  ResidencyUseRole,
} from '../api/types';

const EM_DASH = '—';

/** TASK-1055 — LM Studio's "split the model across every card" placement id. */
export const MULTI_DEVICE = 'multi';
const SPLIT_LABEL = 'Split across cards';

/** "GPU 0 — NVIDIA RTX 2000 Ada Generation" -> "GPU 0"; falls back to the raw id if a device is unknown. */
export function deviceShortLabel(deviceId: string | null, devices: ResidencyDevice[]): string {
  if (!deviceId) return '';
  if (deviceId === MULTI_DEVICE) return SPLIT_LABEL;
  const device = devices.find((candidate) => candidate.id === deviceId);
  if (!device) return deviceId;
  return splitDeviceLabel(device.label).title;
}

/** Splits a device label at its em dash: title "GPU 0", subtitle "NVIDIA RTX 2000 Ada Generation". */
export function splitDeviceLabel(label: string): { title: string; subtitle: string | null } {
  const [head, ...rest] = label.split('—');
  const title = head?.trim() || label;
  const subtitle = rest.join('—').trim();
  return { title, subtitle: subtitle || null };
}

/** One plain sentence for the model's current residency (the drawer's status line). */
export function formatModelStatus(model: ResidencyCatalogueModel, devices: ResidencyDevice[]): string {
  if (model.kind === 'remote') return 'Remote API · no GPU memory';
  if (model.kind === 'builtin') return 'Built in · nothing to load';
  if (model.status === 'loading') return 'Loading…';
  if (model.status === 'unloading') return 'Unloading…';

  // Text, never colour alone (WCAG 1.4.1): the generic code only repeats the sentence, so it is dropped.
  if (model.status === 'failed') return failedLabel(model);

  if (model.status === 'loaded' && model.residency) {
    const device = deviceShortLabel(model.residency.device, devices);
    const bytes = model.residency.bytes ?? model.size.bytes;
    const sizeText =
      bytes === null ? 'size unknown' : `${formatBytes(bytes)} ${model.residency.bytesSource === 'measured' ? 'measured' : 'estimated'}`;
    return device ? `Loaded · ${device} · ${sizeText}` : `Loaded · ${sizeText}`;
  }

  // not_loaded
  if (model.size.bytes === null) return 'Not loaded · size unknown';
  const prefix = model.size.source === 'measured' ? '' : '~';
  const loadPart = model.loadSeconds !== null ? ` · loads in ${Math.round(model.loadSeconds)} s` : '';
  return `Not loaded · ${prefix}${formatBytes(model.size.bytes)}${loadPart}`;
}

function failedLabel(model: ResidencyCatalogueModel): string {
  const code = model.error?.code;
  return code && code !== 'LOAD_FAILED' ? `Load failed · ${code}` : 'Load failed';
}

/** The failed load's own message, for the row's detail/tooltip — null when the model has not failed. */
export function formatLoadFailureDetail(model: ResidencyCatalogueModel): string | null {
  if (model.status !== 'failed') return null;
  return model.error?.message || null;
}

/** A size with its provenance: "1.5 GB measured" / "~1.5 GB est." — an estimate is never shown as an observation. */
export function formatSizeWithSource(bytes: number | null, source: 'measured' | 'catalogue' | 'estimated' | 'unknown'): string {
  if (bytes === null || source === 'unknown') return 'size unknown';
  return source === 'measured' ? `${formatBytes(bytes)} measured` : `~${formatBytes(bytes)} est.`;
}

export type StateTone = 'ok' | 'warn' | 'critical' | 'neutral' | 'busy';

export interface StateWhere {
  /** Short state word(s): "Loaded", "Not loaded", "Remote API"… */
  state: string;
  tone: StateTone;
  /** Where / how big: "GPU 0 · 1.5 GB measured", "Needs ~1.5 GB est. · loads in ~7 s". */
  where: string;
}

/** The "State · where" column (artboard 01). */
export function formatStateWhere(model: ResidencyCatalogueModel, devices: ResidencyDevice[]): StateWhere {
  if (model.kind === 'remote') return { state: 'Remote API', tone: 'neutral', where: 'Cloud · no GPU memory' };
  if (model.kind === 'builtin') return { state: 'Built in', tone: 'neutral', where: 'Compiled into its library · nothing to load' };
  if (model.status === 'loading') return { state: 'Loading…', tone: 'busy', where: needsText(model) };
  if (model.status === 'unloading') return { state: 'Unloading…', tone: 'busy', where: residentWhere(model, devices) };
  if (model.status === 'failed') return { state: failedLabel(model), tone: 'critical', where: model.error?.message || needsText(model) };
  if (model.status === 'loaded') {
    const unmatched = model.identity.matched === false;
    return { state: unmatched ? 'Loaded · unmatched' : 'Loaded', tone: unmatched ? 'warn' : 'ok', where: residentWhere(model, devices) };
  }
  const pinned = model.keepPolicy.kind === 'always';
  return { state: 'Not loaded', tone: pinned ? 'warn' : 'neutral', where: needsText(model) };
}

/** TASK-1055 — the per-card bytes the service measured, when it reported any (a split LM Studio model has one per card). */
function measuredDeviceBytes(model: ResidencyCatalogueModel): Array<{ device: string; bytes: number }> {
  return model.residency?.deviceBytes?.filter((entry) => typeof entry.bytes === 'number') ?? [];
}

function residentWhere(model: ResidencyCatalogueModel, devices: ResidencyDevice[]): string {
  const residency = model.residency;
  const perCard = measuredDeviceBytes(model);
  if (perCard.length > 1 || (perCard.length === 1 && residency?.device === MULTI_DEVICE)) {
    const cards = perCard.map((entry) => `${deviceShortLabel(entry.device, devices)} ${formatBytes(entry.bytes)}`).join(' · ');
    return [`${cards} measured`, ...(model.identity.matched === false ? ['not in the catalogue'] : [])].join(' · ');
  }
  const device = residency ? deviceShortLabel(residency.device, devices) : '';
  const single = perCard[0];
  const bytes = single ? single.bytes : (residency?.bytes ?? model.size.bytes);
  const source = single ? 'measured' : residency && residency.bytes !== null ? residency.bytesSource : model.size.source;
  const size = formatSizeWithSource(bytes, source);
  const parts = [device, size === 'size unknown' ? 'Size unknown' : size].filter(Boolean);
  if (model.identity.matched === false) parts.push('not in the catalogue');
  return parts.join(' · ');
}

function needsText(model: ResidencyCatalogueModel): string {
  if (model.size.bytes === null || model.size.source === 'unknown') return 'Size unknown';
  const size = formatSizeWithSource(model.size.bytes, model.size.source);
  const load = model.loadSeconds !== null ? ` · loads in ~${Math.round(model.loadSeconds)} s` : '';
  return `Needs ${size}${load}`;
}

/** The "Keep policy" column. Remote and built-in rows hold no memory: "Not applicable". */
export function formatKeepPolicy(model: ResidencyCatalogueModel): { label: string; reason: string } {
  if (model.kind !== 'resident') return { label: 'Not applicable', reason: 'Nothing to load or unload' };
  return { label: model.keepPolicy.label, reason: model.keepPolicy.reason };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** "5 agents · 3 tenants", "Routing policy", "Pipeline stage of 15 ASR agents", or "No consumer". */
export function formatUsedBy(usage: ResidencyUsage): string {
  const consumers = usage.consumers;
  if (usage.agentCount > 0) return `${plural(usage.agentCount, 'agent')} · ${plural(usage.tenantCount, 'tenant')}`;
  if (consumers?.routingPolicies) return consumers.routingPolicies === 1 ? 'Routing policy' : `${consumers.routingPolicies} routing policies`;
  if (consumers?.pipelineStages) return `Pipeline stage of ${plural(consumers.pipelineStages, 'ASR agent')}`;
  if (consumers?.workflowNodes) return `${plural(consumers.workflowNodes, 'workflow node')}`;
  if (consumers?.fallbacks) return `Fallback of ${plural(consumers.fallbacks, 'agent')}`;
  return 'No consumer';
}

/** The muted second line of "Used by": live path first, else the routing tasks it serves. */
export function formatUsedByNote(usage: ResidencyUsage): string {
  if (usage.liveConsultation) return 'Live consultations';
  const tasks = [...new Set(usage.uses.filter((use) => use.role === 'routing').map((use) => humanizeTaskLabel(use.task)))];
  return tasks.join(', ');
}

function formatLatency(ms: number): string {
  if (ms >= 1000) {
    const seconds = Math.round(ms / 100) / 10;
    return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
  }
  return `${Math.round(ms)} ms`;
}

/** "12 req/min · p50 410 ms · 2 in flight · used 5 min ago", or an em dash when nothing is known. */
export function formatTraffic(model: ResidencyCatalogueModel, now: Date = new Date()): string {
  const residency = model.residency;
  if (!residency) return EM_DASH;
  const parts: string[] = [];
  if (residency.requestsPerMin !== null) parts.push(`${Math.round(residency.requestsPerMin * 10) / 10} req/min`);
  if (residency.p50LatencyMs !== null) parts.push(`p50 ${formatLatency(residency.p50LatencyMs)}`);
  if (residency.inFlight > 0) parts.push(`${residency.inFlight} in flight`);
  if (residency.lastUsedAt) parts.push(`used ${formatRelativeTime(residency.lastUsedAt, now)}`);
  return parts.length > 0 ? parts.join(' · ') : EM_DASH;
}

/** Problems chip: a failed load, an instance no catalogue row claims, or a pinned model that is not resident. */
export function isProblemModel(model: ResidencyCatalogueModel): boolean {
  if (model.kind !== 'resident') return false;
  if (model.status === 'failed') return true;
  if (isUnmatchedInstance(model)) return true;
  return isPinnedNotResident(model);
}

/** Live path chip: a live-consultation consumer, or the implicit live-path pin. */
export function isLivePathModel(model: ResidencyCatalogueModel): boolean {
  return model.usage.liveConsultation || model.keepPolicy.source === 'implicit-live-path';
}

function isUnmatchedInstance(model: ResidencyCatalogueModel): boolean {
  return model.kind === 'resident' && model.identity.matched === false && model.identity.reportedKey !== null;
}

function isPinnedNotResident(model: ResidencyCatalogueModel): boolean {
  return model.kind === 'resident' && model.keepPolicy.kind === 'always' && (model.status === 'not_loaded' || model.status === 'failed');
}

const ROW_ACTION_ORDER: readonly ('load' | 'unload' | 'reload')[] = ['load', 'unload', 'reload'];
const ROW_ACTION_LABEL: Record<'load' | 'unload' | 'reload' | 'link', string> = {
  load: 'Load…',
  unload: 'Unload…',
  reload: 'Reload…',
  link: 'Link…',
};

/** The ONE primary row button — `edit_policy` never renders its own button; it lives in the drawer. */
export function primaryRowAction(actions: ResidencyAction[]): 'load' | 'unload' | 'reload' | null {
  return ROW_ACTION_ORDER.find((action) => actions.includes(action)) ?? null;
}

export function primaryRowActionLabel(action: 'load' | 'unload' | 'reload' | 'link'): string {
  return ROW_ACTION_LABEL[action];
}

export type RowAction = 'load' | 'unload' | 'reload' | 'link';

/**
 * What the row's primary button does. Remote / built-in rows and services with
 * no control API get none (a button that would 404 is worse than none); an
 * instance no catalogue row claims is linked before anything else.
 */
export function rowActionFor(service: ResidencyServiceGroup, model: ResidencyCatalogueModel): RowAction | null {
  if (!service.controllable || model.kind !== 'resident') return null;
  if (isUnmatchedInstance(model)) return 'link';
  return primaryRowAction(model.actions);
}

/**
 * TASK-1055 (E10) — every action the DRAWER footer offers, in order. Unlike the
 * row's single primary button, a loaded LM Studio model offers Reload (with
 * options) next to Unload. Nothing for a service with no control API, or for
 * a remote / built-in model.
 */
export function drawerActions(service: ResidencyServiceGroup, model: ResidencyCatalogueModel): Array<'load' | 'unload' | 'reload'> {
  if (!service.controllable || model.kind !== 'resident') return [];
  const out: Array<'load' | 'unload' | 'reload'> = [];
  if (model.actions.includes('load')) out.push('load');
  if (model.actions.includes('unload')) out.push('unload');
  const loadedLmStudio = service.service === 'lm-studio' && model.status === 'loaded';
  if (model.actions.includes('reload') ? service.service === 'lm-studio' : loadedLmStudio && model.actions.includes('unload')) out.push('reload');
  return out;
}

/**
 * TASK-1055 (E8) — GPU bars from the per-card bytes the services measured.
 * Where a loaded model reports `residency.deviceBytes`, its share on each card
 * replaces the server's estimate (a split LM Studio model shows its real share
 * per card), and the unattributed remainder is recomputed with the ONE formula
 * (`used − Σ per-model bytes`). Devices are returned untouched (same array)
 * when no model reports per-card bytes.
 */
export function withMeasuredDeviceBytes(devices: ResidencyDevice[], services: ResidencyServiceGroup[]): ResidencyDevice[] {
  const reported = services.flatMap((service) =>
    service.models
      .filter((model) => model.status === 'loaded' && measuredDeviceBytes(model).length > 0)
      .map((model) => ({ service: service.service, model, perCard: measuredDeviceBytes(model) })),
  );
  if (reported.length === 0) return devices;
  return devices.map((device) => {
    let changed = false;
    const models = device.models.map((entry) => {
      const match = reported.find((r) => r.service === entry.service && r.model.modelRef === entry.modelRef);
      if (!match) return entry;
      const share = match.perCard.find((card) => card.device === device.id);
      changed = true;
      return { ...entry, bytes: share ? share.bytes : 0, bytesSource: 'measured' as const };
    });
    for (const r of reported) {
      const share = r.perCard.find((card) => card.device === device.id);
      if (!share || models.some((entry) => entry.service === r.service && entry.modelRef === r.model.modelRef)) continue;
      changed = true;
      models.push({ service: r.service, modelRef: r.model.modelRef, name: r.model.name, bytes: share.bytes, bytesSource: 'measured' });
    }
    if (!changed) return device;
    const kept = models.filter((entry) => entry.bytes !== 0);
    const attributedBytes = kept.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    return { ...device, models: kept, attributedBytes, unattributedBytes: Math.max(0, device.usedBytes - attributedBytes) };
  });
}

/** TASK-1055 (OD-2) — a pinned or live-path model can be unloaded, but only with a reason (audited). */
export function requiresUnloadReason(model: ResidencyCatalogueModel): boolean {
  return model.keepPolicy.kind === 'always' || isLivePathModel(model);
}

/** TASK-1055 (OD-2) — who loses the model when it is unloaded, one plain line per kind of consumer. */
export function liveConsumerLines(model: ResidencyCatalogueModel): string[] {
  const usage = model.usage;
  const lines: string[] = [];
  if (usage.agentCount > 0) lines.push(`${plural(usage.agentCount, 'agent')} · ${plural(usage.tenantCount, 'tenant')}`);
  const c = usage.consumers;
  if (c?.workflowNodes) lines.push(plural(c.workflowNodes, 'workflow node'));
  if (c?.pipelineStages) lines.push(`${plural(c.pipelineStages, 'ASR pipeline stage')}`);
  if (c?.routingPolicies) lines.push(c.routingPolicies === 1 ? 'Routing policy' : `${c.routingPolicies} routing policies`);
  if (c?.fallbacks) lines.push(`Fallback of ${plural(c.fallbacks, 'agent')}`);
  if (usage.liveConsultation) lines.push('Live consultations');
  return lines;
}

/** TASK-1055 — the devices a model holds SEPARATE copies on (unload one at a time); none for an LM Studio split. */
export function unloadDeviceChoices(model: ResidencyCatalogueModel): string[] {
  if (model.residency?.device === MULTI_DEVICE) return [];
  const perCard = measuredDeviceBytes(model);
  return perCard.length > 1 ? perCard.map((entry) => entry.device) : [];
}

/** "5.4 of 16 GB used" — both figures forced to the SAME unit (GiB) so they read as one comparison. */
export function formatGpuUsage(usedBytes: number, totalBytes: number): string {
  const toGiB = (bytes: number) => bytes / 1024 ** 3;
  const round = (value: number) => Math.round(value * 10) / 10;
  const display = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
  return `${display(round(toGiB(usedBytes)))} of ${display(round(toGiB(totalBytes)))} GB used`;
}

/** "data 4 s old" from the OLDEST agent report (F7) — "just now" under 5 s. */
export function formatDataAge(oldestReportAt: string | null, now: Date = new Date()): string {
  if (!oldestReportAt) return 'no service has reported yet';
  const at = new Date(oldestReportAt).getTime();
  if (Number.isNaN(at)) return 'no service has reported yet';
  const seconds = Math.max(0, Math.round((now.getTime() - at) / 1000));
  if (seconds < 5) return 'data just now';
  if (seconds < 60) return `data ${seconds} s old`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `data ${minutes} min old`;
  return `data ${Math.floor(minutes / 60)} h old`;
}

/** "3 of 3 services reporting" — a service counts when its last probe answered and its report is not stale. */
export function formatReportingServices(services: ResidencyServiceGroup[], staleServices: string[]): string {
  const reporting = services.filter((service) => service.reachable && !staleServices.includes(service.service)).length;
  return `${reporting} of ${services.length} services reporting`;
}

// ── Needs attention (artboard 01) ───────────────────────────────────────────

export type AttentionKind = 'over_headroom' | 'mismatch' | 'live_path_not_loaded';

export interface AttentionItem {
  key: string;
  kind: AttentionKind;
  severity: 'critical' | 'warning';
  /** Text tag — the non-colour signal. */
  tag: string;
  title: string;
  body: string;
  device?: ResidencyDevice;
  service?: ResidencyServiceGroup;
  model?: ResidencyCatalogueModel;
}

/**
 * Derived client-side from the catalogue, ordered by risk to live
 * consultations: a GPU past its headroom (a cold load there fails or evicts a
 * live-path model), then an instance no catalogue row claims (enforce would
 * load a second copy), then a pinned model that is not resident.
 */
export function deriveAttentionItems(catalogue: ModelResidencyCatalogueResponse): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const device of catalogue.devices) {
    if (!device.overHeadroom) continue;
    const { title } = splitDeviceLabel(device.label);
    const unattributed = device.unattributedBytes > 0 ? `${formatBytes(device.unattributedBytes)} on this card is not attributed to any model. ` : '';
    items.push({
      key: `gpu:${device.id}`,
      kind: 'over_headroom',
      severity: 'critical',
      tag: 'Critical',
      title: `${title} is past its headroom — ${formatBytes(device.freeBytes)} free, ${formatBytes(device.headroomBytes)} should stay free`,
      body: `${unattributed}A cold load here may fail or evict a live-path model.`,
      device,
    });
  }

  for (const service of catalogue.services) {
    for (const model of service.models) {
      if (!isUnmatchedInstance(model)) continue;
      const best = model.identity.candidates[0];
      items.push({
        key: `mismatch:${service.service}:${model.modelRef}`,
        kind: 'mismatch',
        severity: 'warning',
        tag: 'Mismatch',
        title: `${service.label} is running ${model.identity.reportedKey ?? model.modelRef}, which no catalogue model claims`,
        body: best
          ? `Best match: “${best.name}” (${best.strength} match). Until it is linked, that catalogue model reads as not loaded and enforce would load a second copy.`
          : 'No catalogue model looks like it. Link it to the model it serves, or leave it unmanaged.',
        service,
        model,
      });
    }
  }

  for (const service of catalogue.services) {
    for (const model of service.models) {
      if (!isPinnedNotResident(model)) continue;
      const users = formatUsedBy(model.usage);
      const coldLoad = model.loadSeconds !== null ? ` (~${Math.round(model.loadSeconds)} s)` : '';
      items.push({
        key: `pinned:${service.service}:${model.modelRef}`,
        kind: 'live_path_not_loaded',
        severity: 'warning',
        tag: 'Live path',
        title: model.status === 'failed' ? `${model.name} is pinned but its last load failed` : `${model.name} is pinned but not loaded`,
        body: `${users === 'No consumer' ? 'It is pinned' : `Used by ${users}`}. The next request pays a cold load${coldLoad}.`,
        service,
        model,
      });
    }
  }

  return items;
}

// ── Keep-policy / usage vocabulary shared with the drawer ───────────────────

const KEEP_POLICY_CLASS: Record<ResidencyKeepPolicyKind, ResidencyPolicyClass> = { always: 'PINNED', warm: 'WARM', on_demand: 'ON_DEMAND' };

/** Maps the plain-language radio choice to the write-side `ModelResidencyPolicy.class` enum. */
export function keepPolicyKindToClass(kind: ResidencyKeepPolicyKind): ResidencyPolicyClass {
  return KEEP_POLICY_CLASS[kind];
}

export const USE_ROLE_LABEL: Record<ResidencyUseRole, string> = {
  primary: 'Primary',
  fallback: 'Fallback',
  routing: 'Routing policy',
  pipeline_stage: 'Pipeline stage',
  workflow_node: 'Workflow node',
};

const KNOWN_TASK_LABEL: Record<string, string> = {
  SPEECH_TO_TEXT: 'Speech-to-text',
  TEXT_GENERATION: 'Text generation',
  TEXT_TO_SPEECH: 'Text-to-speech',
  NAMED_ENTITY_RECOGNITION: 'Named entity recognition',
};

/** A consumer's `task` is an `AgentTask` (`SPEECH_TO_TEXT`) or an `AiRoutingPolicy` task key
 *  (`guardrail.judge`) — humanize whatever comes back rather than enumerating every possible value
 *  (no raw SCREAMING_CASE or dotted enums in the UI). */
export function humanizeTaskLabel(task: string): string {
  const known = KNOWN_TASK_LABEL[task];
  if (known) return known;
  const words = task.toLowerCase().split(/[._]/).filter(Boolean);
  if (words.length === 0) return task;
  return words.map((word, index) => (index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word)).join(' ');
}

/** Suggestion verbs (`load | unload | pin | unpin`) as a word for the badge. */
export function suggestionVerb(action: string): string {
  const known: Record<string, string> = { load: 'Load', unload: 'Unload', pin: 'Pin', unpin: 'Unpin' };
  return known[action] ?? humanizeTaskLabel(action);
}
