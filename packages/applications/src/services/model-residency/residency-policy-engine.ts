import {
  type RecommendationAction,
  type RecommendationReason,
  type ResidencyClassName,
  type ResidencyClassSource,
  residencyKey,
} from './model-residency.types';

/**
 * TASK-1005 §5.3 — the residency policy engine, as PURE functions.
 *
 * No I/O, no clock of its own, no DI: the service feeds it one observation of
 * the fleet and gets back the actions it would take. Keeping it pure is what
 * makes shadow mode trustworthy — the SAME decisions are computed whether or
 * not they are sent, so a week of shadow recommendations (owner OD-1) is a
 * faithful preview of enforcement rather than a separate code path.
 *
 * Three invariants hold for every output, and the tests pin each one:
 *
 *  1. A PINNED model (explicit class, implicit live path, or pinned by an
 *     operator) is NEVER an eviction candidate.
 *  2. A model with in-flight work, or resident for less than
 *     `minResidencySeconds`, is never an eviction candidate (busy guard +
 *     anti-thrash).
 *  3. If a model cannot be made to fit, NOTHING is evicted for it — a
 *     half-made room is pure loss.
 */

export interface EngineSettings {
  /** Share of each device's total memory never handed out (default 15 %). Time-slicing gives no memory isolation. */
  headroomPercent: number;
  /** A resident model younger than this is not evictable (anti-thrash). */
  minResidencySeconds: number;
  /** A model unloaded less than this long ago is not reloaded (anti-thrash). */
  reloadCooldownSeconds: number;
  /** Requests/min the EWMA must reach for a WARM model to count a window. */
  promotionRateThreshold: number;
  /** Consecutive windows at or above the threshold before a WARM model is promoted. */
  promotionWindows: number;
}

/** One memory pool. `freeBytes` is MEASURED (DCGM for a GPU, the agent's own probe for a host CPU pool). */
export interface EngineDevice {
  id: string;
  kind: 'gpu' | 'cpu';
  totalBytes: number;
  freeBytes: number;
}

/** One (service, model) pair the engine may act on — resident, or desired but not resident. */
export interface EngineModel {
  service: string;
  modelRef: string;
  resident: boolean;
  /** Physical devices it occupies (resident) or would occupy (not resident). LM Studio spans both cards. */
  devices: string[];
  /** MEASURED footprint (resident: the agent's measurement; not resident: `AiModel.observedMemoryMb`). `null` = never measured. */
  bytes: number | null;
  inFlight: number;
  /** Never evicted: class PINNED, the implicit live path, or pinned by an operator. */
  pinned: boolean;
  /** Whether the serving agent itself holds the model pinned (so its own idle TTL cannot evict it). */
  agentPinned: boolean;
  desiredClass: ResidencyClassName;
  classSource: ResidencyClassSource;
  /** Higher = more valuable to keep. Default 0. */
  priority: number;
  /** Idle TTL the CONTROLLER enforces; `null` leaves expiry to the serving process's own cache. */
  idleTtlSeconds: number | null;
  idleSeconds: number;
  residentSeconds: number;
  /** Measured reload cost (p50 of the load histogram, else the last measured load). `null` = unknown. */
  reloadSeconds: number | null;
  /** The controller knows how to load it (a controllable service and a resolvable load spec). */
  loadable: boolean;
  requestsPerMin: number | null;
}

export interface EngineDecision {
  action: RecommendationAction;
  service: string;
  modelRef: string;
  reason: RecommendationReason;
  devices: string[];
  bytes: number | null;
}

/** A reload cost nobody has measured yet is assumed to be this — conservative against evicting it, not against loading it. */
export const UNKNOWN_RELOAD_SECONDS = 10;

const keyOf = (m: Pick<EngineModel, 'service' | 'modelRef'>): string => residencyKey(m.service, m.modelRef);
/** TASK-1055 review R1-F9 — one resident COPY (stt / nlp keep one per device): evicting one copy leaves the others. */
const copyOf = (m: Pick<EngineModel, 'service' | 'modelRef' | 'devices'>): string => `${keyOf(m)}|${m.devices.join(',')}`;

/** `1 + max(0, priority)` — priority 0 is weight 1; a negative priority is not made MORE evictable than the default. */
function priorityWeight(priority: number): number {
  return 1 + Math.max(0, priority);
}

/**
 * `idleSeconds × (1 / reloadSeconds) × (1 / priorityWeight)` — HIGHER means
 * evict sooner: long idle, cheap to bring back, low priority. A ~100 s LM Studio
 * reload therefore scores two orders of magnitude below a 1 s NLP classifier
 * with the same idleness (TASK-1005 §10.1).
 */
export function evictionScore(model: Pick<EngineModel, 'idleSeconds' | 'reloadSeconds' | 'priority'>): number {
  const reload = Math.max(0.1, model.reloadSeconds ?? UNKNOWN_RELOAD_SECONDS);
  return Math.max(0, model.idleSeconds) * (1 / reload) * (1 / priorityWeight(model.priority));
}

/** The busy guard, the pin guard and the minimum-residency guard, in one place. */
export function isEvictable(model: EngineModel, settings: EngineSettings): boolean {
  return (
    model.resident &&
    !model.pinned &&
    model.inFlight === 0 &&
    model.residentSeconds >= settings.minResidencySeconds &&
    // A candidate whose footprint was never measured cannot be credited as freed memory.
    model.bytes !== null &&
    model.bytes > 0
  );
}

/** Free memory minus the headroom share of the device's TOTAL, floored at zero. */
export function usableBytes(device: EngineDevice, settings: EngineSettings): number {
  return Math.max(0, device.freeBytes - device.totalBytes * (settings.headroomPercent / 100));
}

export interface MakeRoomPlan {
  fits: boolean;
  /** In eviction order. Always empty when `fits` is false. */
  evict: EngineModel[];
}

/**
 * Can `needBytes` be placed on `deviceIds` (pooled — a multi-card model spans
 * them), and if not, which evictable residents would make it fit?
 *
 * Candidates are residents sharing at least one of the devices, taken in
 * DESCENDING `evictionScore` until the pooled usable memory covers the need.
 * If every candidate together still falls short, the answer is "does not fit,
 * evict nothing" (invariant 3).
 */
export function planMakeRoom(
  needBytes: number,
  deviceIds: string[],
  devices: EngineDevice[],
  residents: EngineModel[],
  settings: EngineSettings,
  usableOverride?: Map<string, number>,
): MakeRoomPlan {
  const targets = new Set(deviceIds);
  let available = 0;
  for (const device of devices) {
    if (!targets.has(device.id)) continue;
    available += usableOverride?.get(device.id) ?? usableBytes(device, settings);
  }
  if (needBytes <= available) return { fits: true, evict: [] };

  const candidates = residents
    .filter((m) => isEvictable(m, settings) && m.devices.some((d) => targets.has(d)))
    .sort((a, b) => evictionScore(b) - evictionScore(a));

  const evict: EngineModel[] = [];
  for (const candidate of candidates) {
    // Credit only the share of a multi-card candidate that lies on a target device.
    const overlap = candidate.devices.filter((d) => targets.has(d)).length / candidate.devices.length;
    available += (candidate.bytes ?? 0) * overlap;
    evict.push(candidate);
    if (needBytes <= available) return { fits: true, evict };
  }
  return { fits: false, evict: [] };
}

/**
 * EWMA request rate per model, with promotion HYSTERESIS: a WARM model is
 * promoted only after `promotionWindows` consecutive windows at or above the
 * threshold, and demoted only once its EWMA drops below HALF the threshold —
 * a band rather than a line, so a rate hovering at the threshold does not
 * flip the model in and out every tick.
 */
export class PromotionTracker {
  private readonly state = new Map<string, { ewma: number; windows: number; promoted: boolean }>();

  /** One window's observed rate (requests/min). `alpha` is the EWMA weight of the new observation. */
  observe(key: string, ratePerMin: number, settings: EngineSettings, alpha = 0.3): void {
    const previous = this.state.get(key);
    const ewma = previous ? alpha * ratePerMin + (1 - alpha) * previous.ewma : ratePerMin;
    const windows = ewma >= settings.promotionRateThreshold ? (previous?.windows ?? 0) + 1 : 0;

    let promoted = previous?.promoted ?? false;
    if (!promoted && windows >= settings.promotionWindows) promoted = true;
    if (promoted && ewma < settings.promotionRateThreshold / 2) promoted = false;

    this.state.set(key, { ewma, windows, promoted });
  }

  isPromoted(key: string): boolean {
    return this.state.get(key)?.promoted ?? false;
  }

  promotedKeys(): Set<string> {
    return new Set([...this.state].filter(([, s]) => s.promoted).map(([key]) => key));
  }
}

/** When each (service, model) was last unloaded — the re-load cool-down's memory. */
export class CooldownTracker {
  private readonly unloadedAt = new Map<string, number>();

  noteUnloaded(key: string, atMs: number): void {
    this.unloadedAt.set(key, atMs);
  }

  blocks(key: string, nowMs: number, cooldownSeconds: number): boolean {
    const at = this.unloadedAt.get(key);
    return at !== undefined && nowMs - at < cooldownSeconds * 1000;
  }
}

export interface PlanTickInput {
  models: EngineModel[];
  devices: EngineDevice[];
  settings: EngineSettings;
  /** Keys (`service|modelRef`) the promotion tracker currently holds promoted. */
  promoted: Set<string>;
  /** True when the re-load cool-down blocks this key. */
  coolingDown: (key: string) => boolean;
}

/**
 * One pass of §5.3 — steps 2–5 (step 1, observe, is the caller's; step 6,
 * act-or-recommend, is the service's):
 *
 *  - PIN: a resident desired-PINNED model the agent does not itself hold pinned.
 *  - PLACE: every desired model that is not resident — PINNED, promoted WARM —
 *    in best-fit-DECREASING order of measured footprint, making room with the
 *    cost-aware score, or recording `admission_rejected`.
 *  - EXPIRE: an idle, unpinned, non-promoted resident past the TTL the
 *    controller owns.
 */
export function planTick(input: PlanTickInput): EngineDecision[] {
  const { models, devices, settings, promoted, coolingDown } = input;
  const decisions: EngineDecision[] = [];
  const usable = new Map(devices.map((d) => [d.id, usableBytes(d, settings)]));
  const evicted = new Set<string>();

  const isDesired = (m: EngineModel): boolean =>
    m.desiredClass === 'PINNED' || m.pinned || (m.desiredClass === 'WARM' && promoted.has(keyOf(m))) || m.inFlight > 0;

  // ── pin ─────────────────────────────────────────────────────────────────
  for (const m of models) {
    if (m.resident && m.desiredClass === 'PINNED' && !m.agentPinned) {
      decisions.push({ action: 'pin', service: m.service, modelRef: m.modelRef, reason: 'live_path_pin', devices: m.devices, bytes: m.bytes });
    }
  }

  // ── place ───────────────────────────────────────────────────────────────
  const toPlace = models
    .filter((m) => !m.resident && m.loadable && isDesired(m) && !coolingDown(keyOf(m)))
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));

  for (const m of toPlace) {
    // TASK-1051 review (F8) — no size at all (never measured, no catalogue size): the
    // footprint is unknown, so it is never placed against 0 bytes. The admission is
    // rejected (the service meters it as `no_size`), as an operator's un-forced load is.
    if (m.bytes === null) {
      decisions.push({ action: 'load', service: m.service, modelRef: m.modelRef, reason: 'admission_rejected', devices: m.devices, bytes: null });
      continue;
    }
    const need = m.bytes;
    const residents = models.filter((r) => r.resident && !evicted.has(copyOf(r)));
    const plan = planMakeRoom(need, m.devices, devices, residents, settings, usable);

    if (!plan.fits) {
      decisions.push({ action: 'load', service: m.service, modelRef: m.modelRef, reason: 'admission_rejected', devices: m.devices, bytes: m.bytes });
      continue;
    }
    for (const victim of plan.evict) {
      evicted.add(copyOf(victim));
      decisions.push({
        action: 'unload',
        service: victim.service,
        modelRef: victim.modelRef,
        reason: 'make_room',
        devices: victim.devices,
        bytes: victim.bytes,
      });
      credit(usable, victim.devices, victim.bytes ?? 0);
    }
    credit(usable, m.devices, -need);
    const reason: RecommendationReason = m.desiredClass === 'WARM' && !m.pinned ? 'promotion_rate' : 'live_path_pin';
    decisions.push({ action: 'load', service: m.service, modelRef: m.modelRef, reason, devices: m.devices, bytes: m.bytes });
  }

  // ── expire ──────────────────────────────────────────────────────────────
  for (const m of models) {
    if (!m.resident || evicted.has(copyOf(m)) || isDesired(m)) continue;
    if (m.idleTtlSeconds === null || m.idleSeconds <= m.idleTtlSeconds) continue;
    if (m.residentSeconds < settings.minResidencySeconds) continue;
    decisions.push({ action: 'unload', service: m.service, modelRef: m.modelRef, reason: 'idle_ttl_expired', devices: m.devices, bytes: m.bytes });
  }

  return decisions;
}

/** Spread `bytes` evenly over `deviceIds` in the running usable-memory map (negative = consume). */
function credit(usable: Map<string, number>, deviceIds: string[], bytes: number): void {
  if (deviceIds.length === 0) return;
  const share = bytes / deviceIds.length;
  for (const id of deviceIds) usable.set(id, Math.max(0, (usable.get(id) ?? 0) + share));
}
