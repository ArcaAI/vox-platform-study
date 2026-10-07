import type { ModelResidencyRecommendation } from './dto';
import type { RecommendationAction, RecommendationReason, ResidencyOperationStatus } from './model-residency.types';

/**
 * TASK-1005 — the in-memory record of asynchronous loads.
 *
 * A 5 GB LM Studio load takes ~100 s (§10.1), past Cloudflare's 100 s edge
 * timeout for a browser request, so an operator load answers 202 with an
 * operation id and runs in the background; the console polls
 * `GET operations/:id`. BOUNDED: once `capacity` is reached the oldest
 * FINISHED record is dropped (a running one never is). Per process and lost on
 * restart — an operation is progress reporting, not state; the durable record
 * of what happened is the sys-event audit trail.
 */

export interface ResidencyOperation {
  id: string;
  action: 'load' | 'replace';
  service: string;
  modelRef: string;
  status: ResidencyOperationStatus;
  error: { code: string; message: string } | null;
  startedAt: string;
  finishedAt: string | null;
}

export class ResidencyOperationRegistry {
  private readonly operations = new Map<string, ResidencyOperation>();

  constructor(private readonly capacity = 200) {}

  start(op: Pick<ResidencyOperation, 'id' | 'action' | 'service' | 'modelRef'>, now = new Date()): ResidencyOperation {
    const record: ResidencyOperation = { ...op, status: 'running', error: null, startedAt: now.toISOString(), finishedAt: null };
    this.operations.set(record.id, record);
    this.trim();
    return record;
  }

  succeed(id: string, now = new Date()): void {
    const op = this.operations.get(id);
    if (op) Object.assign(op, { status: 'succeeded', finishedAt: now.toISOString() });
  }

  fail(id: string, error: { code: string; message: string }, now = new Date()): void {
    const op = this.operations.get(id);
    if (op) Object.assign(op, { status: 'failed', error, finishedAt: now.toISOString() });
  }

  get(id: string): ResidencyOperation | undefined {
    const op = this.operations.get(id);
    return op ? { ...op } : undefined;
  }

  /** The running operation for this (service, model), if any. */
  runningFor(service: string, modelRef: string): ResidencyOperation | undefined {
    for (const op of this.operations.values()) {
      if (op.status === 'running' && op.service === service && op.modelRef === modelRef) return { ...op };
    }
    return undefined;
  }

  running(): ResidencyOperation[] {
    return [...this.operations.values()].filter((op) => op.status === 'running').map((op) => ({ ...op }));
  }

  private trim(): void {
    if (this.operations.size <= this.capacity) return;
    for (const [id, op] of this.operations) {
      if (this.operations.size <= this.capacity) return;
      if (op.status !== 'running') this.operations.delete(id);
    }
  }
}

// ── TASK-1051 F4 — standing recommendations ────────────────────────────────────

/** The fields of a controller decision the recommendation store keeps. */
export interface ResidencyConclusion {
  action: RecommendationAction;
  service: string;
  modelRef: string;
  reason: RecommendationReason;
}

/** A recommendation as the store holds it: the wire shape plus when it was last confirmed (ms). */
type StoredRecommendation = ModelResidencyRecommendation & { lastMs: number };

export interface ShadowCounts {
  loads: number;
  unloads: number;
  refusedOverBudget: number;
  duplicateLoads: number;
}

const conclusionOf = (c: Pick<ResidencyConclusion, 'action' | 'reason'>): string => `${c.action}|${c.reason}`;
const pairOf = (c: Pick<ResidencyConclusion, 'service' | 'modelRef'>): string => `${c.service}|${c.modelRef}`;
const strip = ({ lastMs: _lastMs, ...wire }: StoredRecommendation): ModelResidencyRecommendation => ({ ...wire });

/**
 * TASK-1051 F4 (D-2) — the controller's recommendations, in memory, per process.
 *
 * SHADOW: ONE standing row per `action|service|modelRef|reason`. The controller
 * reaches the same conclusion every 10 s tick; a repeat refreshes `at` (last
 * confirmed) and `repeats` and keeps `id` and `firstSeenAt`, so the console sees
 * four rows, not a hundred copies of them. A row not re-confirmed within
 * `staleAfterMs` is no longer the controller's opinion and is omitted (and a later
 * recurrence starts a new row).
 *
 * ENFORCE: an append-only bounded log (the command was sent; each one is an event),
 * newest first, with `firstSeenAt = at` and `repeats = 1`.
 *
 * DISMISS hides a STANDING conclusion for one (service, model) until the controller
 * records a DIFFERENT conclusion for that pair, or until the standing row goes stale
 * (the condition stopped holding); then the dismissal clears, so a later recurrence
 * shows again. Enforce-log rows are history — never dismissable, never hidden.
 */
export class ResidencyRecommendationStore {
  private readonly standing = new Map<string, StoredRecommendation>();
  private readonly log: StoredRecommendation[] = [];
  /** `service|modelRef` → the dismissed `action|reason`. */
  private readonly dismissed = new Map<string, string>();
  readonly counts: ShadowCounts = { loads: 0, unloads: 0, refusedOverBudget: 0, duplicateLoads: 0 };
  /** When the first shadow row of this process was recorded. */
  earliestShadowAt: number | null = null;

  constructor(
    private readonly staleAfterMs = 60_000,
    private readonly logCapacity = 200,
  ) {}

  /** Record a shadow conclusion; `created` is false when it re-confirmed a standing row. */
  recordShadow(decision: ResidencyConclusion, id: string, now: number): { recommendation: ModelResidencyRecommendation; created: boolean } {
    // A stale row (and the dismissal of it) goes BEFORE the recurrence is matched against it.
    this.prune(now);
    this.clearDismissalOnChange(decision);
    const key = `${conclusionOf(decision)}|${pairOf(decision)}`;
    const existing = this.standing.get(key);
    if (existing && now - existing.lastMs <= this.staleAfterMs) {
      existing.lastMs = now;
      existing.at = new Date(now).toISOString();
      existing.repeats += 1;
      return { recommendation: existing, created: false };
    }
    const at = new Date(now).toISOString();
    const row: StoredRecommendation = { id, at, firstSeenAt: at, repeats: 1, ...pick(decision), mode: 'shadow', applied: false, lastMs: now };
    this.standing.set(key, row);
    this.earliestShadowAt ??= now;
    this.count(decision);
    return { recommendation: row, created: true };
  }

  /** Record an enforce-mode event. The returned object is the stored one (`applied` is flipped on it when the command settles). */
  recordEnforce(decision: ResidencyConclusion, id: string, applied: boolean, now: number): ModelResidencyRecommendation {
    this.clearDismissalOnChange(decision);
    const at = new Date(now).toISOString();
    const row: StoredRecommendation = { id, at, firstSeenAt: at, repeats: 1, ...pick(decision), mode: 'enforce', applied, lastMs: now };
    this.log.unshift(row);
    if (this.log.length > this.logCapacity) this.log.length = this.logCapacity;
    this.count(decision);
    return row;
  }

  /** Live standing rows and the enforce log, dismissed ones omitted, most recently confirmed first (copies). */
  visible(now: number): ModelResidencyRecommendation[] {
    this.prune(now);
    return [...[...this.standing.values()].filter((row) => this.dismissed.get(pairOf(row)) !== conclusionOf(row)), ...this.log]
      .sort((a, b) => b.lastMs - a.lastMs)
      .map(strip);
  }

  /** Hide a live STANDING recommendation; false when no such id is standing (an enforce-log event is not dismissable). */
  dismiss(id: string, now: number): boolean {
    this.prune(now);
    const row = [...this.standing.values()].find((r) => r.id === id);
    if (!row) return false;
    this.dismissed.set(pairOf(row), conclusionOf(row));
    return true;
  }

  private clearDismissalOnChange(decision: ResidencyConclusion): void {
    const dismissed = this.dismissed.get(pairOf(decision));
    if (dismissed !== undefined && dismissed !== conclusionOf(decision)) this.dismissed.delete(pairOf(decision));
  }

  private prune(now: number): void {
    for (const [key, row] of this.standing) {
      if (now - row.lastMs <= this.staleAfterMs) continue;
      this.standing.delete(key);
      // The condition stopped holding: the dismissal of it expires with it.
      if (this.dismissed.get(pairOf(row)) === conclusionOf(row)) this.dismissed.delete(pairOf(row));
    }
  }

  private count(decision: ResidencyConclusion): void {
    if (decision.reason === 'admission_rejected') this.counts.refusedOverBudget += 1;
    else if (decision.action === 'load') this.counts.loads += 1;
    else if (decision.action === 'unload') this.counts.unloads += 1;
  }
}

function pick(decision: ResidencyConclusion): ResidencyConclusion {
  return { action: decision.action, service: decision.service, modelRef: decision.modelRef, reason: decision.reason };
}
