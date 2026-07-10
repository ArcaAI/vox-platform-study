import { Inject, Injectable, Logger, type MessageEvent, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, type Subscription, finalize, interval, map, merge, takeWhile } from 'rxjs';
import { ContextItemEntity, ContextItemFactory, ContextItemRepository } from '@arcaai/domains';
import { IRedisCacheService } from '../../baseServices/redis';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { StreamingAudioBridgeService } from '../../stt/streaming/streamingAudioBridge.service';
import { mapSmrGenerateResponse } from '../summary/smr-v2-generate';
import { HarnessPolicyService } from '../../harness-policy/harness-policy.service';
import { ConsultationPipelineEvent, type ContextAddedPayload, type ContextRemovedPayload } from '../events';
import {
  LiveDocEngineConfigResponse,
  LiveDocSessionStatsResponse,
  LiveDocSessionsListResponse,
  LiveSummaryEntityDto,
  LiveSummaryEventDto,
  LiveSummaryGroundednessDto,
  LiveSummaryGroundednessSegmentDto,
} from './dto';
import { LIVE_SOAP_RESPONSE_FORMAT, buildRunningSummary, parseSoapJson, parseSoapSections } from './soap-parser';

/** Shared SOAP output instruction — describes the four sections for prose-only providers. */
const SOAP_OUTPUT_INSTRUCTION =
  'Output EXACTLY these four sections, each header on its own line, in this order, and nothing else:\n\n' +
  'Subjective: <patient-reported history and symptoms>\n' +
  'Objective: <exam findings, vitals, labs>\n' +
  'Assessment: <clinical impressions / diagnoses>\n' +
  'Plan: <next steps, medications, follow-up>\n\n' +
  'Leave a section blank after its header if there is nothing yet. Do not invent details or add other sections.';

/**
 * Safety cap on the transcript delta sent per flush (sliding-window fallback,
 * TASK-340 P0-B): the incremental prompt only sends new transcript since the
 * last successful flush, but if SMR keeps failing the un-flushed delta grows —
 * this bounds it so a busy/failing session can't send an unbounded prompt.
 */
const MAX_DELTA_CHARS = 12000;

/**
 * Atomic single-owner lock scripts (TASK-459 C5-06). Redis serialises each Lua
 * body, so `acquire` is a true compare-and-set — two instances racing to own one
 * consultation can never both win (unlike the old unconditional `SET`). `release`
 * and `renew` are fenced: they touch the key only while its value is still THIS
 * instance's id, so a non-owner can neither free nor refresh the real owner's
 * lock. The `-- live-doc:lock:*` tag lets the unit test's cache mock dispatch
 * without parsing Lua. KEYS[1]=lockKey, ARGV[1]=instanceId, ARGV[2]=ttlSeconds.
 */
const LOCK_ACQUIRE_SCRIPT = `-- live-doc:lock:acquire
local cur = redis.call('GET', KEYS[1])
if cur == false or cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
  return 1
end
return 0`;

const LOCK_RELEASE_SCRIPT = `-- live-doc:lock:release
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

const LOCK_RENEW_SCRIPT = `-- live-doc:lock:renew
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 0`;

/** A live transcript segment fed into the watcher. */
export interface LiveTranscriptSegment {
  text: string;
  isFinal: boolean;
  segmentId?: string;
}

/** Parameters to begin a per-consultation watcher session. */
export interface StartLiveDocumentationParams {
  consultationId: string;
  tenantId: string;
  userId?: string;
  /** STT streaming session id; when present the watcher subscribes to `stt:result:{sessionId}`. */
  sessionId?: string;
}

interface LiveSession {
  consultationId: string;
  tenantId: string;
  userId?: string;
  sessionId?: string;
  transcriptParts: string[];
  /**
   * Live-folded notes/labs/files, keyed by their `contextItemId` so a
   * soft-delete (TASK-342 GAP #3d) can drop the exact entry. Insertion order is
   * preserved, so the assembled notes block stays byte-identical to the prior
   * `string[]` representation on the add-only path.
   */
  contextNotes: { contextItemId: string; text: string }[];
  pendingSegments: number;
  segmentCounter: number;
  lastSegmentId?: string;
  timer?: ReturnType<typeof setTimeout>;
  lastPayload?: LiveSummaryEventDto;
  sttSubscription?: Subscription;
  /** Cross-instance "stop" control-channel reader (TASK-340 P1-A). */
  controlSubscription?: Subscription;
  /** Periodic fenced owner-lock renewal handle (TASK-459 C5-06). */
  lockRenewalTimer?: ReturnType<typeof setInterval>;
  /** Monotonic flush id; only the latest generation may publish (TASK-340 P0-A). */
  generation: number;
  /** Aborts the in-flight SMR/NLP HTTP calls when a newer flush supersedes them. */
  abortController?: AbortController;
  /** How many `transcriptParts` have already been folded into `lastPayload` (incremental prompt cursor, P0-B). */
  flushedTranscriptCount: number;
  /** Epoch ms of the last SMR-producing flush — drives the min-interval throttle (P0-A). */
  lastFlushAt: number;
  /** Pending trailing flush scheduled by the throttle. */
  throttleTimer?: ReturnType<typeof setTimeout>;
  /** Epoch ms of the last durable snapshot write — drives the durable-snapshot throttle (P1-C). */
  lastDurableAt: number;
  /** The single upserted PRE_SUMMARY snapshot row for this session (P1-C). */
  snapshotEntity?: ContextItemEntity;
  snapshotId?: string;
  /** Observability counters (P2). */
  flushCount: number;
  staleDropCount: number;
  /** How many flushes truncated an oversized delta and carried the overflow forward (C5-04). */
  truncatedDeltaCount: number;
  /** Epoch ms when the watcher session started — surfaced in the admin stats snapshot (TASK-341 B1). */
  startedAt: number;
}

/**
 * LiveDocumentationService — net-new realtime watcher (Clinical Workflow Playground).
 *
 * Per-consultation, transient (Redis only — no Prisma models). Consumes live
 * STT final segments (from `stt:result:{sessionId}`) plus context-add events,
 * debounces (~3 final segments OR ~5s idle), calls the existing SMR client for
 * a running summary and the NLP client (`/api/v1/classify/tokens`) for medical
 * entities, then publishes a {@link LiveSummaryEventDto} to the Redis pub/sub
 * channel `consultation:live-summary:{consultationId}`. The SSE endpoint relays
 * that channel verbatim. Optionally persists the last snapshot as a PRE_SUMMARY
 * context item on stop.
 */
@Injectable()
export class LiveDocumentationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveDocumentationService.name);
  private readonly sessions = new Map<string, LiveSession>();

  private readonly CHANNEL_PREFIX = 'consultation:live-summary:';
  private readonly SNAPSHOT_TTL = 3600; // 1h — transient last-snapshot for SSE late-join
  private readonly LOCK_TTL = 3600; // 1h — single-owner lock auto-expires if an instance dies (P1-A)
  /**
   * Fencing token identifying this owner. A random suffix keeps it distinct even
   * for two instances constructed in the same process/millisecond (same pid +
   * `Date.now()`), so the compare-and-set acquire and fenced release/renew can
   * never confuse two owners (TASK-459 C5-06).
   */
  private readonly instanceId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  /** Renew the owner lock at half its TTL so a live session never lets it lapse (C5-06). */
  private readonly lockRenewalMs = Math.floor((this.LOCK_TTL * 1000) / 2);

  // TASK-341 B1 — admin live console: cross-instance per-session stats in Redis.
  private readonly STATS_PREFIX = 'live-doc:stats:'; // + consultationId → JSON LiveDocSessionStatsResponse
  private readonly ACTIVE_SET_PREFIX = 'live-doc:active:'; // + tenantId → Set<consultationId>
  // TASK-341 B3 — runtime kill-switch override (read at start, toggled by the admin console).
  private readonly CONFIG_ENABLED_KEY = 'live-doc:config:enabled'; // JSON { enabled, updatedAt, updatedBy, reason }
  private readonly CONFIG_CONTROL_CHANNEL = 'live-doc:config:control'; // cross-instance toggle fan-out

  /**
   * In-memory mirror of the Redis kill-switch override (TASK-341 B3). `null` =
   * no override → the env default (`this.enabled`) applies. Kept fresh via a
   * boot read + a pub/sub subscription so `start()` (sync hot path) can resolve
   * the effective flag without a per-call Redis round-trip.
   */
  private engineEnabledOverride: boolean | null = null;
  private engineConfigUpdatedAt: string | null = null;
  private engineConfigUpdatedBy: string | null = null;
  private configSubscription?: Subscription;

  private readonly nlpServiceUrl: string;
  private readonly smrServiceUrl: string;
  private readonly guardrailServiceUrl: string;
  private readonly segmentThreshold: number;
  private readonly debounceMs: number;
  private readonly heartbeatMs: number;
  private readonly enabled: boolean;
  private readonly minIntervalMs: number;
  private readonly durableSnapshotMs: number;
  private readonly smrMaxTokens: number;
  private readonly smrTimeoutMs: number;
  private readonly smrProvider?: string;
  private readonly smrModel?: string;
  private readonly statsTtl: number;
  private readonly groundednessEnabled: boolean;
  private readonly groundednessTimeoutMs: number;
  private readonly groundednessMaxRetries: number;
  private readonly groundednessRetryBackoffMs: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @Inject(IRedisCacheService) private readonly cacheService: IRedisCacheService,
    private readonly redisSubscriber: RedisSubscriberService,
    @Optional() private readonly audioBridge?: StreamingAudioBridgeService,
    @Optional() @Inject(ContextItemRepository) private readonly contextItemRepository?: ContextItemRepository,
    // TASK-356 D-7 — resolver for the tenant's effective SMR {provider, model}.
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // TASK-479 (SOTA D2) — X-Service-Token for the guardrail groundedness hop
    // (SecretsService is provided by the @Global SecretsModule). Optional so unit
    // fixtures and non-DI construction paths compile; when unset an empty token is
    // sent (the guardrail's empty-token dev bypass, TASK-465).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    this.nlpServiceUrl = this.configService.get<string>('NLP_URL') ?? 'http://localhost:8864';
    this.smrServiceUrl = this.configService.get<string>('SMR_URL') ?? 'http://localhost:8862';
    this.segmentThreshold = Number(this.configService.get('LIVE_DOC_SEGMENT_THRESHOLD') ?? 3);
    this.debounceMs = Number(this.configService.get('LIVE_DOC_DEBOUNCE_MS') ?? 5000);
    this.heartbeatMs = Number(this.configService.get('LIVE_DOC_HEARTBEAT_MS') ?? 15000);
    // Kill-switch (P2): any value other than the literal 'false' keeps it on.
    this.enabled = String(this.configService.get('LIVE_DOC_ENABLED') ?? 'true') !== 'false';
    // Min seconds between SMR calls for one session — protects the small local LM pool (P0-A).
    this.minIntervalMs = Number(this.configService.get('LIVE_DOC_MIN_INTERVAL_MS') ?? 4000);
    // Durable-snapshot throttle: 0 disables periodic durable writes (P1-C).
    this.durableSnapshotMs = Number(this.configService.get('LIVE_DOC_DURABLE_SNAPSHOT_MS') ?? 30000);
    // Bounded live-generation params (P0-B).
    this.smrMaxTokens = Number(this.configService.get('LIVE_DOC_SMR_MAX_TOKENS') ?? 1500);
    this.smrTimeoutMs = Number(this.configService.get('LIVE_DOC_SMR_TIMEOUT_MS') ?? 20000);
    this.smrProvider = this.configService.get<string>('LIVE_DOC_SMR_PROVIDER') || undefined;
    this.smrModel = this.configService.get<string>('LIVE_DOC_SMR_MODEL') || undefined;
    // TTL on the per-session Redis stats snapshot + active set (TASK-341 B1). A
    // crashed/quiet session falls out of the admin "live" list after this window;
    // refreshed on every flush so an actively-flushing session stays visible.
    this.statsTtl = Number(this.configService.get('LIVE_DOC_STATS_TTL_SEC') ?? 300);
    // TASK-479 (SOTA D2) — output groundedness gate. Off by default (dev/CI bypass,
    // mirroring TASK-478's `enabled` posture); enabling is the clinical/ops rollout
    // step and requires the guardrail's self-hosted NLI model staged. Degrade-safe →
    // fail-CLOSED: a blip is absorbed by a bounded retry, a sustained outage marks
    // segments `unverified` — an error path can NEVER mark `grounded`.
    this.guardrailServiceUrl = this.configService.get<string>('GUARDRAIL_URL') ?? 'http://localhost:8863';
    this.groundednessEnabled = String(this.configService.get('LIVE_DOC_GROUNDEDNESS_ENABLED') ?? 'false') === 'true';
    this.groundednessTimeoutMs = Number(this.configService.get('LIVE_DOC_GROUNDEDNESS_TIMEOUT_MS') ?? 5000);
    this.groundednessMaxRetries = Number(this.configService.get('LIVE_DOC_GROUNDEDNESS_MAX_RETRIES') ?? 1);
    this.groundednessRetryBackoffMs = Number(this.configService.get('LIVE_DOC_GROUNDEDNESS_RETRY_BACKOFF_MS') ?? 200);
  }

  /**
   * Boot-time kill-switch wiring (TASK-341 B3): seed the in-memory override
   * mirror from Redis (so a persisted toggle survives restart) and subscribe to
   * the control channel so a toggle on any instance updates this instance's
   * mirror live — no restart required.
   */
  async onModuleInit(): Promise<void> {
    await this.refreshEngineOverride();
    try {
      const config$ = await this.redisSubscriber.subscribeToChannel(this.CONFIG_CONTROL_CHANNEL);
      if (config$) {
        this.configSubscription = config$.subscribe({
          next: (raw: string) => this.applyEngineConfigMessage(raw),
          error: () => {
            /* config-channel errors are non-fatal */
          },
        });
      }
    } catch (error) {
      this.logger.warn({ message: 'Failed to subscribe to live-doc config channel', error: error instanceof Error ? error.message : String(error) });
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.configSubscription?.unsubscribe();
    for (const consultationId of [...this.sessions.keys()]) {
      try {
        await this.stop(consultationId);
      } catch {
        // best-effort teardown on shutdown
      }
    }
  }

  // ------------------------------------------------------------------
  // Session lifecycle
  // ------------------------------------------------------------------

  /** Begin watching a consultation. Idempotent — restarting reuses the session. */
  start(params: StartLiveDocumentationParams): void {
    // Feature kill-switch (P2 + TASK-341 B3): never spin up a watcher when
    // disabled. The effective flag is the runtime Redis override when present,
    // else the `LIVE_DOC_ENABLED` env default — resolved synchronously from the
    // in-memory mirror so this stays on the recording controller's hot path.
    if (!this.isEngineEnabled()) {
      this.logger.warn({ message: 'Live documentation disabled (kill-switch) — start ignored', consultationId: params.consultationId });
      return;
    }

    const existing = this.sessions.get(params.consultationId);
    if (existing) {
      // Re-bind a (possibly new) STT session without losing accumulated state.
      if (params.sessionId && params.sessionId !== existing.sessionId) {
        this.attachSttStream(existing, params.sessionId);
      }
      return;
    }

    const session: LiveSession = {
      consultationId: params.consultationId,
      tenantId: params.tenantId,
      userId: params.userId,
      sessionId: params.sessionId,
      transcriptParts: [],
      contextNotes: [],
      pendingSegments: 0,
      segmentCounter: 0,
      generation: 0,
      flushedTranscriptCount: 0,
      lastFlushAt: 0,
      lastDurableAt: Date.now(),
      flushCount: 0,
      staleDropCount: 0,
      truncatedDeltaCount: 0,
      startedAt: Date.now(),
    };
    this.sessions.set(params.consultationId, session);

    if (params.sessionId) {
      this.attachSttStream(session, params.sessionId);
    }

    // Claim single-owner lock + subscribe to the cross-instance control channel so a
    // `stop` routed to a different instance can tear this owner down (P1-A). Fire-and-
    // forget so `start` stays synchronous for the recording controller.
    void this.claimOwnership(session);

    this.logger.log({ message: 'Live documentation session started', consultationId: params.consultationId, sessionId: params.sessionId });
  }

  isActive(consultationId: string): boolean {
    return this.sessions.has(consultationId);
  }

  /**
   * Stop watching. Resilient + cross-instance correct (TASK-340 P1-A): when this
   * instance owns the session it flushes a final snapshot, optionally persists it,
   * and tears down locally; regardless of ownership it then signals the owner via
   * the control channel, releases the single-owner lock, and publishes the terminal
   * `closed` marker — so a `stop` routed to a non-owner instance still ends the
   * stream and frees the lock.
   */
  async stop(consultationId: string, opts?: { persistSnapshot?: boolean }): Promise<LiveSummaryEventDto | null> {
    const session = this.sessions.get(consultationId);
    let finalPayload: LiveSummaryEventDto | null = null;

    if (session) {
      // Drain the WHOLE backlog before the final snapshot (I-2): one flush is capped
      // at MAX_DELTA_CHARS, so a > 12k un-flushed backlog at stop would keep only the
      // head and drop the most-recent transcript (assessment/plan/closing). Flush
      // repeatedly until the cursor catches up to the full transcript. Bounded twice
      // over — break as soon as a flush makes no forward progress (cursor stuck, e.g.
      // SMR down / nothing new), and a hard iteration cap as a final safety net so a
      // non-advancing cursor can never loop forever.
      const maxDrainIterations = session.transcriptParts.length + 1;
      for (let i = 0; i < maxDrainIterations; i++) {
        const cursorBefore = session.flushedTranscriptCount;
        finalPayload = await this.flush(consultationId, { force: true }).catch((error) => {
          this.logger.warn({ message: 'Final flush failed on stop', consultationId, error: error instanceof Error ? error.message : String(error) });
          return session.lastPayload ?? null;
        });
        if (session.flushedTranscriptCount >= session.transcriptParts.length || session.flushedTranscriptCount === cursorBefore) {
          break; // caught up, or no forward progress → stop draining
        }
      }

      // Finalize the durable snapshot: opt-in via `persistSnapshot`, or simply close
      // out the live row if periodic snapshots already created one this session.
      if ((opts?.persistSnapshot || session.snapshotId) && finalPayload?.runningSummary?.trim()) {
        await this.persistDurableSnapshot(session, finalPayload, { force: true });
      }

      this.teardownLocal(session);
    }

    // TASK-341 B1 — drop this session from the admin live view (stats key +
    // active-set member). When stop is routed to a non-owner instance the
    // tenant is unknown here, so we can only delete the consultation-keyed stats
    // snapshot; the orphaned active-set member self-heals on the next
    // `getActiveSessions` read and via the set's TTL.
    await this.clearStats(consultationId, session?.tenantId);

    // Tell the (possibly remote) owner to tear down, BEFORE the terminal marker so SSE
    // clients see `closed` last. Lock release is FENCED (C5-06): a stop routed to a
    // non-owner never nukes the real owner's lock. When we owned the session,
    // `teardownLocal` above already released it — so only the no-local-session path
    // needs a release here, to self-heal an orphaned lock we happen to own (the real
    // owner, if remote, frees its own via the control `stop`). Avoids the double
    // release (M-5).
    await this.safeChannelPublish(this.controlChannel(consultationId), JSON.stringify({ type: 'stop', ts: new Date().toISOString() }));
    if (!session) {
      await this.releaseOwnership(consultationId);
    }

    const closed: LiveSummaryEventDto = {
      ...(finalPayload ?? this.emptyPayload(consultationId)),
      closed: true,
    };
    await this.safePublish(consultationId, closed);

    this.logger.log({ message: 'Live documentation session stopped', consultationId, owned: !!session });
    return finalPayload;
  }

  // ------------------------------------------------------------------
  // Ingestion + debounce
  // ------------------------------------------------------------------

  /** Fold a transcript segment into the running state; flush on threshold/idle. */
  ingestSegment(consultationId: string, segment: LiveTranscriptSegment): void {
    const session = this.sessions.get(consultationId);
    if (!session) return;
    if (!segment.isFinal) return; // only final segments contribute to the running summary

    const text = segment.text?.trim();
    if (!text) return;

    session.transcriptParts.push(text);
    session.pendingSegments += 1;
    session.segmentCounter += 1;
    session.lastSegmentId = segment.segmentId ?? `seg-${session.segmentCounter}`;

    if (session.pendingSegments >= this.segmentThreshold) {
      this.clearTimer(session);
      void this.flush(consultationId);
    } else {
      this.scheduleFlush(session);
    }
  }

  /**
   * Context-add reaction: a note/lab/file added mid-visit nudges the running
   * summary so the next snapshot reflects it.
   */
  @OnEvent(ConsultationPipelineEvent.ContextAdded)
  handleContextAdded(payload: ContextAddedPayload): void {
    const session = this.sessions.get(payload.consultationId);
    if (!session) return;

    const label = payload.subType ? `[${payload.subType}] ` : '';
    const note = (payload.contentPreview ?? '').trim();
    const text = note ? `${label}${note}` : `${label}${payload.contextType} added`;

    // UPSERT by contextItemId (TASK-344): the OCR enrichment processor re-emits
    // ContextAdded for the SAME contextItemId once it has extracted text. Update the
    // existing note in place (preserving insertion order) instead of appending a
    // duplicate, so one attachment yields exactly one running-summary note.
    const existing = session.contextNotes.find((n) => n.contextItemId === payload.contextItemId);
    if (existing) {
      existing.text = text;
    } else {
      session.contextNotes.push({ contextItemId: payload.contextItemId, text });
    }
    this.scheduleFlush(session);
  }

  /**
   * Context-remove reaction (TASK-342 GAP #3d): a note/lab/file soft-deleted
   * mid-visit is dropped from the running summary's notes by `contextItemId`, so
   * the next flush no longer re-injects it. No-op when the session or the note
   * isn't tracked; only schedules a flush when an entry was actually removed.
   */
  @OnEvent(ConsultationPipelineEvent.ContextRemoved)
  handleContextRemoved(payload: ContextRemovedPayload): void {
    const session = this.sessions.get(payload.consultationId);
    if (!session) return;

    const before = session.contextNotes.length;
    session.contextNotes = session.contextNotes.filter((n) => n.contextItemId !== payload.contextItemId);
    if (session.contextNotes.length !== before) {
      this.scheduleFlush(session);
    }
  }

  // ------------------------------------------------------------------
  // Flush — SMR + NLP aggregation, publish
  // ------------------------------------------------------------------

  /**
   * Recompute the running summary + entities and publish them. Public so the
   * debounce paths and `stop()` can invoke it (and so it is unit-testable).
   *
   * `force` (used by `stop`) bypasses the min-interval throttle for the final flush.
   * Overlapping flushes are made safe by a per-session generation id: a newer flush
   * aborts the prior in-flight SMR/NLP call and only the latest generation may
   * publish, advance the incremental cursor, or persist (TASK-340 P0-A).
   */
  async flush(consultationId: string, opts?: { force?: boolean }): Promise<LiveSummaryEventDto | null> {
    const session = this.sessions.get(consultationId);
    if (!session) return null;
    this.clearTimer(session);

    const transcript = session.transcriptParts.join(' ').trim();
    const notes = session.contextNotes.map((n) => n.text).join('\n').trim();
    if (!transcript && !notes) return null;

    // Min-interval throttle (P0-A): coalesce a burst into a single trailing re-run so
    // a busy session never exceeds one SMR call per `LIVE_DOC_MIN_INTERVAL_MS`.
    const elapsed = Date.now() - session.lastFlushAt;
    if (!opts?.force && elapsed < this.minIntervalMs) {
      this.scheduleThrottledFlush(session);
      return session.lastPayload ?? null;
    }

    session.lastFlushAt = Date.now();
    session.pendingSegments = 0;

    // Supersede any in-flight generation: abort its HTTP calls and claim a new id.
    const myGeneration = ++session.generation;
    session.abortController?.abort();
    const abortController = new AbortController();
    session.abortController = abortController;
    const signal = abortController.signal;
    const isStale = (): boolean => this.sessions.get(consultationId) !== session || session.generation !== myGeneration;

    // Incremental prompt (P0-B): refine the prior SOAP note with only the new
    // transcript delta since the last successful flush, keeping prompt size bounded.
    //
    // C5-04 — carry-forward truncation: when the un-flushed backlog exceeds
    // MAX_DELTA_CHARS, take whole segments from the HEAD (oldest-first, the early
    // clinical content) up to the cap and remember how far we got (`deltaEnd`).
    // The cursor advances only over what was actually sent, so the overflow tail
    // is carried into the NEXT flush instead of being dropped and skipped past —
    // the old `slice(-MAX)` kept the tail and then jumped the cursor to the full
    // length, permanently losing the head. `deltaEnd === flushUpTo` in the common
    // (unbounded) case, so bounded deltas behave exactly as before.
    const flushUpTo = session.transcriptParts.length;
    const deltaSegments: string[] = [];
    let deltaEnd = session.flushedTranscriptCount;
    let deltaLen = 0;
    let deltaTruncated = false;
    for (let i = session.flushedTranscriptCount; i < flushUpTo; i++) {
      const part = session.transcriptParts[i];
      const separator = deltaSegments.length > 0 ? 1 : 0; // the joining space
      // The `deltaSegments.length > 0` guard always admits the FIRST segment so the
      // cursor can always advance (no stall). Consequence (M-4): MAX_DELTA_CHARS is a
      // SOFT per-flush bound — a single segment larger than the cap is still sent whole.
      if (deltaSegments.length > 0 && deltaLen + separator + part.length > MAX_DELTA_CHARS) {
        deltaTruncated = true;
        break; // stop at the head boundary — the rest carries forward
      }
      deltaSegments.push(part);
      deltaLen += separator + part.length;
      deltaEnd = i + 1;
    }
    const delta = deltaSegments.join(' ').trim();
    if (deltaTruncated) {
      session.truncatedDeltaCount += 1;
      // PHI-safe: sizes/counts only — never transcript text.
      this.logger.warn({
        message: 'Live summary transcript delta truncated — carrying overflow forward (C5-04)',
        consultationId,
        truncatedDeltaCount: session.truncatedDeltaCount,
        deltaChars: delta.length,
        carriedForwardParts: flushUpTo - deltaEnd,
      });
    }
    const priorNote = session.lastPayload?.runningSummary ?? '';
    const promptText = this.buildSmrUserPrompt(priorNote, delta || transcript, notes);

    // SMR first (a structured S/O/A/P running note), then NER over the resulting
    // `runningSummary` (the canonical text the entity highlight offsets index — so it
    // must be produced before NER runs). Both calls retain the last-good value if the
    // service is down.
    let sections = session.lastPayload?.sections ?? [];
    let runningSummary = priorNote;
    let smrFailed = false;
    let smrLatencyMs = 0;
    const smrStartedAt = Date.now();
    try {
      const smrText = await this.callSmr(promptText, session.tenantId, signal);
      smrLatencyMs = Date.now() - smrStartedAt;
      if (isStale()) return this.dropStale(session);
      const parsed = parseSoapJson(smrText) ?? parseSoapSections(smrText);
      if (parsed.length > 0) {
        sections = parsed;
        runningSummary = buildRunningSummary(parsed);
        // Advance only over the segments actually sent (C5-04): on a truncated
        // flush `deltaEnd < flushUpTo`, so the carried-forward tail is re-sent next.
        session.flushedTranscriptCount = deltaEnd;
      }
    } catch (error) {
      if (isStale()) return this.dropStale(session);
      smrFailed = true;
      this.logger.warn({ message: 'SMR running-summary call failed', consultationId, error: error instanceof Error ? error.message : String(error) });
    }

    let entities = session.lastPayload?.entities ?? [];
    let nlpFailed = false;
    let nlpLatencyMs = 0;
    const nlpStartedAt = Date.now();
    try {
      entities = runningSummary ? await this.callNlp(runningSummary, signal) : [];
      nlpLatencyMs = Date.now() - nlpStartedAt;
    } catch (error) {
      if (isStale()) return this.dropStale(session);
      nlpFailed = true;
      this.logger.warn({ message: 'NLP entity call failed', consultationId, error: error instanceof Error ? error.message : String(error) });
    }

    if (isStale()) return this.dropStale(session);

    // TASK-479 (SOTA D2) — live OUTPUT groundedness gate: verify the generated note
    // against the source transcript (∪ clinician notes, mirroring the durable sensor's
    // transcript ∪ evidence) BETWEEN building it and publishing it, so ungrounded
    // segments carry their mark before the clinician reads them. Degrade-safe →
    // fail-CLOSED: an unavailable gate yields `unverified` (never `grounded`) and the
    // feed still publishes — the live feed is never frozen or dropped by the gate.
    let groundedness: LiveSummaryGroundednessDto | undefined;
    let groundednessLatencyMs = 0;
    if (this.groundednessEnabled && runningSummary) {
      const groundednessStartedAt = Date.now();
      groundedness = await this.checkGroundedness(runningSummary, notes ? `${transcript}\n${notes}` : transcript, signal);
      groundednessLatencyMs = Date.now() - groundednessStartedAt;
      if (isStale()) return this.dropStale(session);
    }

    const payload: LiveSummaryEventDto = {
      consultationId,
      runningSummary,
      sections,
      entities,
      lastSegmentId: session.lastSegmentId,
      ...(groundedness ? { groundedness } : {}),
      updatedAt: new Date().toISOString(),
    };

    session.lastPayload = payload;
    await this.safePublish(consultationId, payload);
    await this.persistDurableSnapshot(session, payload, { force: false });

    session.flushCount += 1;
    // PHI-safe metrics (P2): sizes/latencies/counts only — never transcript or summary text.
    this.logger.log({
      message: 'Live summary flush',
      consultationId,
      generation: myGeneration,
      flushCount: session.flushCount,
      smrLatencyMs,
      nlpLatencyMs,
      smrFailed,
      nlpFailed,
      entityCount: entities.length,
      sectionCount: sections.length,
      summaryChars: runningSummary.length,
      staleDropCount: session.staleDropCount,
      truncatedDeltaCount: session.truncatedDeltaCount,
      // TASK-479 — verdict + latency only (PHI-safe; never the flagged text).
      groundednessVerdict: groundedness?.verdict,
      groundednessLatencyMs,
    });

    // TASK-341 B1 — mirror the same PHI-safe metrics into Redis so the admin
    // live console can observe this (possibly cross-instance) session.
    await this.publishStats(session, {
      generation: myGeneration,
      smrLatencyMs,
      nlpLatencyMs,
      smrFailed,
      nlpFailed,
      entityCount: entities.length,
      sectionCount: sections.length,
      summaryChars: runningSummary.length,
    });
    return payload;
  }

  /** A superseded generation finished late — count it and publish nothing (P0-A). */
  private dropStale(session: LiveSession): null {
    session.staleDropCount += 1;
    return null;
  }

  // ------------------------------------------------------------------
  // SSE relay
  // ------------------------------------------------------------------

  /**
   * SSE source for `GET /consultations/:id/live-summary/stream`. Emits the last
   * stored snapshot immediately (late-join), then relays the Redis channel,
   * with a periodic heartbeat so idle streams survive proxies. Mirrors the
   * job-updates SSE pattern (`subscribeToJobUpdates`).
   */
  subscribeToLiveSummary(consultationId: string): Observable<MessageEvent> {
    const channel = this.channel(consultationId);

    return new Observable<MessageEvent>((subscriber) => {
      let inner: Subscription | null = null;

      this.cacheService
        .get(this.snapshotKey(consultationId))
        .then(async (snapshot) => {
          if (snapshot) {
            subscriber.next({ data: snapshot } as MessageEvent);
          }

          const messages$ = await this.redisSubscriber.subscribeToChannel(channel);

          const relay$ = messages$.pipe(
            map((raw: string): MessageEvent => ({ data: raw }) as MessageEvent),
            takeWhile((event: MessageEvent) => {
              try {
                return JSON.parse(event.data as string).closed !== true;
              } catch {
                return true;
              }
            }, true), // include the terminal `closed` event
            finalize(() => this.redisSubscriber.unsubscribeFromChannel(channel)),
          );

          const heartbeat$ = interval(this.heartbeatMs).pipe(
            map((): MessageEvent => ({ data: JSON.stringify({ type: 'heartbeat', ts: new Date().toISOString() }) }) as MessageEvent),
          );

          inner = merge(relay$, heartbeat$).subscribe({
            next: (event) => subscriber.next(event),
            error: (err) => subscriber.error(err),
            complete: () => subscriber.complete(),
          });
        })
        .catch((error) => {
          this.logger.error({
            message: 'Failed to initialise live-summary SSE subscription',
            consultationId,
            error: error instanceof Error ? error.message : String(error),
          });
          subscriber.next({ data: JSON.stringify({ error: 'Failed to subscribe to live summary', consultationId }) } as MessageEvent);
          subscriber.complete();
        });

      return () => inner?.unsubscribe();
    });
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private attachSttStream(session: LiveSession, sessionId: string): void {
    session.sttSubscription?.unsubscribe();
    session.sessionId = sessionId;
    if (!this.audioBridge) return;

    try {
      session.sttSubscription = this.audioBridge.subscribeToResults(sessionId).subscribe({
        next: (msg) => {
          if (msg?.isFinal && msg.text?.trim()) {
            this.ingestSegment(session.consultationId, { text: msg.text, isFinal: true });
          }
        },
        error: (error) => {
          this.logger.warn({
            message: 'STT result stream error',
            consultationId: session.consultationId,
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
    } catch (error) {
      this.logger.warn({
        message: 'Failed to attach STT result stream — falling back to manual ingest',
        consultationId: session.consultationId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleFlush(session: LiveSession): void {
    if (session.timer) return; // a flush is already pending
    session.timer = setTimeout(() => {
      session.timer = undefined;
      void this.flush(session.consultationId);
    }, this.debounceMs);
  }

  /**
   * Schedule the single trailing re-run for a throttled flush (P0-A). Coalesces a
   * burst into one flush fired exactly when the min-interval window reopens.
   */
  private scheduleThrottledFlush(session: LiveSession): void {
    if (session.throttleTimer) return; // already pending
    const delay = Math.max(0, this.minIntervalMs - (Date.now() - session.lastFlushAt));
    session.throttleTimer = setTimeout(() => {
      session.throttleTimer = undefined;
      void this.flush(session.consultationId);
    }, delay);
  }

  private clearTimer(session: LiveSession): void {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = undefined;
    }
  }

  /**
   * Acquire the single-owner lock and subscribe to the cross-instance control
   * channel (TASK-340 P1-A, hardened in TASK-459 C5-06).
   *
   * The acquire is now an atomic compare-and-set (`LOCK_ACQUIRE_SCRIPT`): when a
   * live foreign instance already owns the consultation we BAIL OUT of the watcher
   * instead of overwriting its lock — that stops the duplicate SMR spend and the
   * duplicate PRE_SUMMARY row. On success we keep the lock fresh with a fenced
   * periodic renewal for the life of the session. Fail-open on a Redis error /
   * outage so a cache blip never kills live documentation in the common
   * single-instance deployment; the durable-snapshot repo dedup is the backstop
   * if two instances ever do run at once.
   */
  private async claimOwnership(session: LiveSession): Promise<void> {
    // `IRedisCacheService.eval` returns `null` (it never throws) when Redis is
    // unavailable, so a cache outage yields `denied === false` — fail open, live
    // docs keep working. Only an explicit `0` (a live foreign owner) stands us down.
    const result = await this.cacheService.eval(LOCK_ACQUIRE_SCRIPT, 1, this.lockKey(session.consultationId), this.instanceId, String(this.LOCK_TTL));
    const denied = result === 0 || result === '0';

    if (denied) {
      this.logger.warn({
        message: 'Live-doc owner lock held by another instance — skipping duplicate watcher',
        consultationId: session.consultationId,
      });
      this.teardownLocal(session); // fenced release is a no-op here (foreign lock left intact)
      return;
    }

    this.startLockRenewal(session);

    try {
      const control$ = await this.redisSubscriber.subscribeToChannel(this.controlChannel(session.consultationId));
      if (!control$) return;
      session.controlSubscription = control$.subscribe({
        next: (raw: string) => this.handleControlMessage(session.consultationId, raw),
        error: () => {
          /* control-channel errors are non-fatal to the watcher */
        },
      });
    } catch (error) {
      this.logger.warn({ message: 'Failed to subscribe to live-doc control channel', consultationId: session.consultationId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Start the periodic fenced lock-renewal loop for a session (C5-06). */
  private startLockRenewal(session: LiveSession): void {
    if (session.lockRenewalTimer) return;
    const timer = setInterval(() => {
      void this.renewOwnership(session.consultationId);
    }, this.lockRenewalMs);
    // Never let the renewal loop hold the process open — teardownLocal clears it.
    (timer as unknown as { unref?: () => void }).unref?.();
    session.lockRenewalTimer = timer;
  }

  /** Refresh the owner lock's TTL, but ONLY while this instance still owns it (fenced, C5-06). */
  private async renewOwnership(consultationId: string): Promise<void> {
    try {
      const result = await this.cacheService.eval(LOCK_RENEW_SCRIPT, 1, this.lockKey(consultationId), this.instanceId, String(this.LOCK_TTL));
      if (result === 0 || result === '0') {
        // We no longer own the lock (foreign takeover / eviction). Stand down this
        // instance's watcher so we stop running a duplicate against the new owner —
        // restoring the single-owner invariant mid-session instead of only logging (M-2).
        this.logger.warn({ message: 'Live-doc owner lock lost — standing down watcher to preserve single-owner invariant', consultationId });
        this.teardownLocal(this.sessions.get(consultationId));
      }
    } catch (error) {
      this.logger.warn({
        message: 'Failed to renew live-doc owner lock',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Release the owner lock, but ONLY when this instance still owns it (fenced compare-and-delete, C5-06). */
  private async releaseOwnership(consultationId: string): Promise<void> {
    try {
      await this.cacheService.eval(LOCK_RELEASE_SCRIPT, 1, this.lockKey(consultationId), this.instanceId);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to release live-doc owner lock',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** React to a cross-instance control message — currently just `stop` → local teardown (P1-A). */
  private handleControlMessage(consultationId: string, raw: string): void {
    let message: { type?: string };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message?.type === 'stop') {
      this.teardownLocal(this.sessions.get(consultationId));
    }
  }

  /**
   * Tear down all local resources for a session and drop it from the in-memory map.
   * Deliberately does NOT call `audioBridge.unsubscribeFromResults(sessionId)` — that
   * aborts EVERY reader on the STT session and would kill the captions WS gateway's
   * reader for the same `sessionId`; our own Observable unsubscribe is enough (P1-B).
   */
  private teardownLocal(session?: LiveSession): void {
    if (!session) return;
    this.clearTimer(session);
    if (session.throttleTimer) {
      clearTimeout(session.throttleTimer);
      session.throttleTimer = undefined;
    }
    if (session.lockRenewalTimer) {
      clearInterval(session.lockRenewalTimer);
      session.lockRenewalTimer = undefined;
    }
    session.abortController?.abort();
    session.sttSubscription?.unsubscribe();
    session.controlSubscription?.unsubscribe();
    // Give up ownership on the way out (fenced — frees only OUR lock; a foreign
    // lock, e.g. on the acquire-denied bail-out path, is left untouched). C5-06.
    void this.releaseOwnership(session.consultationId);
    this.sessions.delete(session.consultationId);
  }

  /**
   * Throttled durable snapshot (TASK-340 P1-C): upsert ONE PRE_SUMMARY row tagged
   * `metadata.subType = 'LIVE_SOAP_SNAPSHOT'` (create on first write, update the same
   * row thereafter) so the in-progress draft survives a restart/late join without
   * writing a row per tick. `force` (final-on-stop) bypasses the interval throttle.
   */
  private async persistDurableSnapshot(session: LiveSession, payload: LiveSummaryEventDto, opts: { force: boolean }): Promise<void> {
    if (!this.contextItemRepository) return;
    if (!opts.force && (this.durableSnapshotMs <= 0 || Date.now() - session.lastDurableAt < this.durableSnapshotMs)) return;

    const content = payload.runningSummary?.trim();
    if (!content) return;

    session.lastDurableAt = Date.now();
    const metaData = { subType: 'LIVE_SOAP_SNAPSHOT', lastSegmentId: session.lastSegmentId, updatedAt: payload.updatedAt };

    try {
      if (!session.snapshotEntity) {
        // Deterministic dedup (TASK-459 C5-06 / review I-1): a prior tick — on THIS
        // instance after a restart, or a racing second instance that slipped past the
        // lock — may already have persisted the live snapshot row. Reuse it instead of
        // minting a SECOND PRE_SUMMARY for the same consultation. Must match on the
        // subType (see findLiveSnapshotRow): `findLatestPreSummary` is NOT subType-aware,
        // so a legacy/case-note PRE_SUMMARY minted AFTER our snapshot would otherwise
        // defeat a naive newest-row guard and create a duplicate LIVE_SOAP_SNAPSHOT.
        const existing = await this.findLiveSnapshotRow(session.consultationId);
        if (existing) {
          existing.content = content;
          existing.metaData = metaData;
          await this.contextItemRepository.update(existing.id, existing);
          session.snapshotEntity = existing;
          session.snapshotId = existing.id;
          this.logger.log({
            message: 'Reused existing live SOAP durable snapshot',
            consultationId: session.consultationId,
            contextItemId: existing.id,
          });
        } else {
          const entity = ContextItemFactory.CreatePreSummary(
            session.tenantId,
            session.consultationId,
            content,
            undefined,
            session.userId ?? 'system',
          );
          entity.metaData = metaData;
          await this.contextItemRepository.create(entity);
          session.snapshotEntity = entity;
          session.snapshotId = entity.id;
          this.logger.log({ message: 'Created live SOAP durable snapshot', consultationId: session.consultationId, contextItemId: entity.id });
        }
      } else {
        session.snapshotEntity.content = content;
        session.snapshotEntity.metaData = metaData;
        await this.contextItemRepository.update(session.snapshotEntity.id, session.snapshotEntity);
      }
    } catch (error) {
      this.logger.warn({ message: 'Failed to persist live SOAP durable snapshot', consultationId: session.consultationId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * The newest LIVE_SOAP_SNAPSHOT row for a consultation, or null (review I-1).
   * `findLatestPreSummary` returns the newest PRE_SUMMARY of ANY subType, so it can
   * hand back a legacy/case-note pre-summary minted after our snapshot — which would
   * make the durable dedup mint a duplicate live row. Filter on the subType and take
   * the newest, mirroring the harness warm-start reader (`findPreSummaries` is
   * createdAt-ASC, so reduce to the max defensively).
   */
  private async findLiveSnapshotRow(consultationId: string): Promise<ContextItemEntity | null> {
    if (!this.contextItemRepository) return null;
    const preSummaries = await this.contextItemRepository.findPreSummaries(consultationId);
    const snapshots = preSummaries.filter((p) => (p.metaData as Record<string, unknown> | undefined)?.subType === 'LIVE_SOAP_SNAPSHOT');
    if (snapshots.length === 0) return null;
    return snapshots.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
  }

  /**
   * Assemble the live SMR user prompt (TASK-340 P0-B). Once a SOAP note exists we
   * send it plus only the new transcript delta ("update the note") instead of the
   * whole transcript, keeping prompt size bounded; the first flush sends the delta
   * as the initial transcript.
   */
  private buildSmrUserPrompt(priorNote: string, delta: string, notes: string): string {
    const notesBlock = notes ? `\n\nClinician notes / labs:\n${notes}` : '';
    if (priorNote.trim()) {
      return (
        'You are assisting a clinician during a live consultation. Update the existing SOAP note below using ONLY the new transcript since the last update; keep prior content unless it is contradicted. ' +
        SOAP_OUTPUT_INSTRUCTION +
        `\n\nCurrent SOAP note so far:\n${priorNote}` +
        `\n\nNew transcript since last update:\n${delta}` +
        notesBlock
      );
    }
    return (
      'You are assisting a clinician during a live consultation. From the transcript and any clinician notes/labs so far, produce a concise, factual running clinical note structured as SOAP. ' +
      SOAP_OUTPUT_INSTRUCTION +
      `\n\nTranscript so far:\n${delta}` +
      notesBlock
    );
  }

  private async callSmr(promptText: string, tenantId: string, signal?: AbortSignal): Promise<string> {
    // TASK-356 D-7 — SMR is a stateless gateway with no model default. Resolve the
    // tenant's effective {provider, model} via the HarnessPolicy cascade (NOT the
    // legacy LIVE_DOC_SMR_PROVIDER/MODEL env); fall back to env only when the
    // resolver is not wired (kept for non-DI construction paths).
    let provider = this.smrProvider;
    let model = this.smrModel;
    if (this.harnessPolicyService) {
      ({ provider, model } = await this.harnessPolicyService.resolveSmrSelection(tenantId));
    }
    // `response_format: json_schema` makes json-schema-capable providers return a
    // deterministic SOAP object (parsed by parseSoapJson); ollama ignores it so we
    // omit it there and fall back to the prose regex parse (P0-C).
    const includeResponseFormat = (provider ?? '').toLowerCase() !== 'ollama';
    const payload = {
      prompt: promptText,
      system_prompt:
        'You are a clinical documentation assistant generating an in-progress, structured SOAP running note. Be concise and faithful to the transcript; never fabricate findings.',
      provider,
      model,
      max_tokens: this.smrMaxTokens,
      stream: false as const,
      response_format: includeResponseFormat ? LIVE_SOAP_RESPONSE_FORMAT : undefined,
    };
    const response = await this.httpService.axiosRef.post(`${this.smrServiceUrl}/api/v1/generate`, payload, {
      timeout: this.smrTimeoutMs,
      headers: { 'Content-Type': 'application/json' },
      signal,
    });
    return mapSmrGenerateResponse(response.data).summary;
  }

  private async callNlp(text: string, signal?: AbortSignal): Promise<LiveSummaryEntityDto[]> {
    const response = await this.httpService.axiosRef.post(
      `${this.nlpServiceUrl}/api/v1/classify/tokens`,
      { text },
      { timeout: 30000, signal },
    );
    // Canonical NLP wire shape (apps/nlp schemas/common.py Entity): text / entity_type / position.{start,end}.
    const raw = (response.data?.entities ?? []) as Array<{
      entity_type?: string;
      text?: string;
      confidence?: number;
      position?: { start?: number; end?: number };
    }>;
    return raw.map((e) => ({
      text: e.text ?? '',
      type: e.entity_type ?? 'UNKNOWN',
      confidence: e.confidence,
      start: e.position?.start,
      end: e.position?.end,
    }));
  }

  /**
   * TASK-479 (SOTA D2) — output-side groundedness gate call.
   *
   * POSTs `{ summary, transcript }` to the guardrail's self-hosted NLI endpoint
   * (`/api/guardrail/ground`, behind `X-Service-Token`) and maps the per-segment
   * verdicts for the SSE payload. Degrade-safe → fail-CLOSED:
   * - a transient blip is absorbed by a bounded retry (verdict comes from the clean re-check);
   * - a sustained outage / timeout / malformed response returns `unverified`;
   * - NO error path can ever return `grounded` (the mapper only accepts the literal
   *   `grounded` verdict from an honest `checked: true` response).
   * PHI-safe logging: attempt counts + error names only — never clinical text.
   */
  private async checkGroundedness(summary: string, transcript: string, signal?: AbortSignal): Promise<LiveSummaryGroundednessDto> {
    const attempts = Math.max(1, this.groundednessMaxRetries + 1);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const token = (await this.secretsService?.getSecretOptional('GUARDRAIL_SERVICE_TOKEN')) ?? '';
        const response = await this.httpService.axiosRef.post(
          `${this.guardrailServiceUrl}/api/guardrail/ground`,
          { summary, transcript },
          {
            timeout: this.groundednessTimeoutMs,
            headers: { 'Content-Type': 'application/json', 'X-Service-Token': token },
            signal,
          },
        );
        const verdict = this.mapGroundednessResponse(response.data);
        if (verdict) return verdict;
        this.logger.warn({ message: 'Groundedness gate returned a malformed verdict — treating as unverified (fail-closed)', attempt });
      } catch (error) {
        this.logger.warn({
          message: 'Groundedness gate call failed',
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (signal?.aborted) break; // superseded — the flush drops this generation as stale
      if (attempt < attempts && this.groundednessRetryBackoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.groundednessRetryBackoffMs));
      }
    }
    // Fail-CLOSED: an unavailable/erroring gate marks the note `unverified` — the
    // clinician sees the text but knows it is unchecked; it is NEVER presented as verified.
    return { verdict: 'unverified', checkedAt: new Date().toISOString() };
  }

  /**
   * Strict wire→DTO mapping for the guardrail `/guardrail/ground` response. Returns
   * `null` for a malformed body (→ fail-closed `unverified` upstream). Only the
   * literal `grounded` verdict string can mark a segment grounded, and only when the
   * service honestly reports `checked: true` — an errored/disabled gate response can
   * never roll up to `grounded`.
   */
  private mapGroundednessResponse(data: unknown): LiveSummaryGroundednessDto | null {
    const body = data as { segments?: unknown; flagged_spans?: unknown; checked?: unknown } | null | undefined;
    if (!body || !Array.isArray(body.segments)) return null;

    // TASK-479 review IMPORTANT-1 — a response we distrust (`checked !== true`: any
    // degrade / error / disabled path) must not drive ANY per-segment verdict, not just
    // the rollup. An honest degrade already sets every segment 'unverified'; this defends
    // against a compromised/buggy guardrail returning 'grounded' segments alongside
    // checked:false — a panel rendering per-segment marks would otherwise show segments as
    // verified from a response the mapper explicitly refused to trust. Only a `checked:true`
    // response may carry a non-'unverified' segment verdict.
    const trusted = body.checked === true;
    const segments: LiveSummaryGroundednessSegmentDto[] = body.segments.map((raw) => {
      const segment = raw as { text?: unknown; verdict?: unknown; score?: unknown; start?: unknown; end?: unknown };
      const verdict = !trusted
        ? 'unverified'
        : segment.verdict === 'grounded'
          ? 'grounded'
          : segment.verdict === 'ungrounded'
            ? 'ungrounded'
            : 'unverified';
      return {
        text: typeof segment.text === 'string' ? segment.text : '',
        verdict,
        score: typeof segment.score === 'number' ? segment.score : undefined,
        start: typeof segment.start === 'number' ? segment.start : undefined,
        end: typeof segment.end === 'number' ? segment.end : undefined,
      };
    });

    const flaggedSpans = Array.isArray(body.flagged_spans)
      ? body.flagged_spans
          .map((raw) => raw as { start?: unknown; end?: unknown })
          .filter((span) => typeof span.start === 'number' && typeof span.end === 'number')
          .map((span) => ({ start: span.start as number, end: span.end as number }))
      : [];

    const anyUngrounded = segments.some((segment) => segment.verdict === 'ungrounded');
    const anyUnverified = segments.some((segment) => segment.verdict === 'unverified');
    const verdict: LiveSummaryGroundednessDto['verdict'] = anyUngrounded
      ? 'ungrounded'
      : anyUnverified || segments.length === 0 || body.checked !== true
        ? 'unverified'
        : 'grounded';

    return { verdict, segments, flaggedSpans, checkedAt: new Date().toISOString() };
  }

  private channel(consultationId: string): string {
    return `${this.CHANNEL_PREFIX}${consultationId}`;
  }

  /** Cross-instance control channel — carries `stop` so a non-owner can end the owner's session (P1-A). */
  private controlChannel(consultationId: string): string {
    return `${this.CHANNEL_PREFIX}${consultationId}:control`;
  }

  /** Single-owner lock key (P1-A). */
  private lockKey(consultationId: string): string {
    return `${this.CHANNEL_PREFIX}${consultationId}:lock`;
  }

  private snapshotKey(consultationId: string): string {
    return `${this.CHANNEL_PREFIX}${consultationId}:last`;
  }

  private emptyPayload(consultationId: string): LiveSummaryEventDto {
    return { consultationId, runningSummary: '', sections: [], entities: [], updatedAt: new Date().toISOString() };
  }

  private async safePublish(consultationId: string, payload: LiveSummaryEventDto): Promise<void> {
    const serialized = JSON.stringify(payload);
    try {
      await this.cacheService.setex(this.snapshotKey(consultationId), this.SNAPSHOT_TTL, serialized);
      await this.cacheService.publish(this.channel(consultationId), serialized);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to publish live summary snapshot',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Publish a raw message to a channel (control signals) without touching the snapshot cache. */
  private async safeChannelPublish(channel: string, message: string): Promise<void> {
    try {
      await this.cacheService.publish(channel, message);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to publish control message',
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ------------------------------------------------------------------
  // TASK-341 B1 — admin live console: per-session stats in Redis
  // ------------------------------------------------------------------

  private statsKey(consultationId: string): string {
    return `${this.STATS_PREFIX}${consultationId}`;
  }

  private activeSetKey(tenantId: string): string {
    return `${this.ACTIVE_SET_PREFIX}${tenantId}`;
  }

  /**
   * Mirror the per-flush PHI-safe metrics into Redis so the admin live console
   * can observe the (possibly cross-instance) session: a TTL-refreshed
   * `live-doc:stats:{consultationId}` snapshot plus membership in the
   * `live-doc:active:{tenantId}` set. Best-effort — a Redis hiccup never breaks
   * the flush.
   */
  private async publishStats(
    session: LiveSession,
    metrics: {
      generation: number;
      smrLatencyMs: number;
      nlpLatencyMs: number;
      smrFailed: boolean;
      nlpFailed: boolean;
      entityCount: number;
      sectionCount: number;
      summaryChars: number;
    },
  ): Promise<void> {
    const snapshot: LiveDocSessionStatsResponse = {
      consultationId: session.consultationId,
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      startedAt: new Date(session.startedAt).toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      flushCount: session.flushCount,
      generation: metrics.generation,
      smrLatencyMs: metrics.smrLatencyMs,
      nlpLatencyMs: metrics.nlpLatencyMs,
      smrFailed: metrics.smrFailed,
      nlpFailed: metrics.nlpFailed,
      staleDropCount: session.staleDropCount,
      entityCount: metrics.entityCount,
      sectionCount: metrics.sectionCount,
      summaryChars: metrics.summaryChars,
    };

    try {
      await this.cacheService.setex(this.statsKey(session.consultationId), this.statsTtl, JSON.stringify(snapshot));
      await this.cacheService.sadd(this.activeSetKey(session.tenantId), session.consultationId);
      // Backstop crash cleanup: a fully-dead tenant set expires on its own.
      await this.cacheService.expire(this.activeSetKey(session.tenantId), this.statsTtl);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to publish live-doc session stats',
        consultationId: session.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Remove a session from the admin live view (stats snapshot + active-set member). */
  private async clearStats(consultationId: string, tenantId?: string): Promise<void> {
    try {
      await this.cacheService.del(this.statsKey(consultationId));
      if (tenantId) {
        await this.cacheService.srem(this.activeSetKey(tenantId), consultationId);
      }
    } catch (error) {
      this.logger.warn({
        message: 'Failed to clear live-doc session stats',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private parseStatsSnapshot(raw: string): LiveDocSessionStatsResponse | null {
    try {
      const parsed = JSON.parse(raw) as Partial<LiveDocSessionStatsResponse>;
      if (parsed && typeof parsed.consultationId === 'string' && typeof parsed.tenantId === 'string') {
        return parsed as LiveDocSessionStatsResponse;
      }
    } catch {
      /* corrupt snapshot — treat as absent */
    }
    return null;
  }

  /**
   * List the tenant's active live-documentation sessions with their latest
   * stats (TASK-341 B2 backing read). Reads the `live-doc:active:{tenantId}`
   * set then enriches each member from its stats snapshot; members whose
   * snapshot has expired (crash / long silence) are self-healed out of the set.
   * Tenant-isolated: a snapshot whose `tenantId` does not match is skipped.
   */
  async getActiveSessions(tenantId: string): Promise<LiveDocSessionsListResponse> {
    const ids = await this.cacheService.smembers(this.activeSetKey(tenantId));
    const items: LiveDocSessionStatsResponse[] = [];
    for (const consultationId of ids) {
      const raw = await this.cacheService.get(this.statsKey(consultationId));
      if (!raw) {
        await this.cacheService.srem(this.activeSetKey(tenantId), consultationId);
        continue;
      }
      const parsed = this.parseStatsSnapshot(raw);
      if (parsed && parsed.tenantId === tenantId) {
        items.push(parsed);
      }
    }
    return { items, total: items.length };
  }

  /**
   * Read one session's stats (TASK-341 B2). Tenant-isolated: returns `null`
   * when the snapshot is absent or belongs to another tenant, so a tenant admin
   * cannot read another tenant's session by guessing a consultation id.
   */
  async getSessionStats(tenantId: string, consultationId: string): Promise<LiveDocSessionStatsResponse | null> {
    const raw = await this.cacheService.get(this.statsKey(consultationId));
    if (!raw) return null;
    const parsed = this.parseStatsSnapshot(raw);
    if (!parsed || parsed.tenantId !== tenantId) return null;
    return parsed;
  }

  // ------------------------------------------------------------------
  // TASK-341 B3 — runtime kill-switch (env default + Redis override)
  // ------------------------------------------------------------------

  /** Effective enabled state: runtime override when set, else the env default. */
  private isEngineEnabled(): boolean {
    return this.engineEnabledOverride ?? this.enabled;
  }

  /** Re-read the Redis override into the in-memory mirror. Missing key → no override. */
  private async refreshEngineOverride(): Promise<void> {
    try {
      const raw = await this.cacheService.get(this.CONFIG_ENABLED_KEY);
      if (!raw) {
        this.engineEnabledOverride = null;
        this.engineConfigUpdatedAt = null;
        this.engineConfigUpdatedBy = null;
        return;
      }
      this.applyEngineConfigMessage(raw);
    } catch {
      /* keep the current mirror on a transient Redis error */
    }
  }

  /** Apply a kill-switch config record (from Redis read or the control channel) to the mirror. */
  private applyEngineConfigMessage(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as { enabled?: unknown; updatedAt?: unknown; updatedBy?: unknown };
      if (typeof parsed?.enabled === 'boolean') {
        this.engineEnabledOverride = parsed.enabled;
        this.engineConfigUpdatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : this.engineConfigUpdatedAt;
        this.engineConfigUpdatedBy = typeof parsed.updatedBy === 'string' ? parsed.updatedBy : null;
      }
    } catch {
      /* ignore corrupt config payloads */
    }
  }

  /** Read the effective live-engine config / kill-switch (TASK-341 B3). */
  async getEngineConfig(): Promise<LiveDocEngineConfigResponse> {
    await this.refreshEngineOverride();
    return {
      enabled: this.isEngineEnabled(),
      envDefault: this.enabled,
      source: this.engineEnabledOverride === null ? 'env-default' : 'redis-override',
      updatedAt: this.engineConfigUpdatedAt ?? undefined,
      updatedBy: this.engineConfigUpdatedBy ?? undefined,
    };
  }

  /**
   * Toggle the runtime kill-switch (TASK-341 B3). Persists a Redis override
   * (survives restart), updates the in-memory mirror so the effect is immediate
   * on this instance, and fans the change out on the control channel so other
   * instances pick it up — no restart required.
   */
  async setEngineEnabled(enabled: boolean, actor?: { userId?: string | null; reason?: string }): Promise<LiveDocEngineConfigResponse> {
    const updatedAt = new Date().toISOString();
    const updatedBy = actor?.userId ?? null;
    const record = { enabled, updatedAt, updatedBy, reason: actor?.reason ?? null };

    try {
      await this.cacheService.set(this.CONFIG_ENABLED_KEY, JSON.stringify(record));
    } catch (error) {
      this.logger.warn({ message: 'Failed to persist live-doc kill-switch override', error: error instanceof Error ? error.message : String(error) });
    }

    this.engineEnabledOverride = enabled;
    this.engineConfigUpdatedAt = updatedAt;
    this.engineConfigUpdatedBy = updatedBy;
    await this.safeChannelPublish(this.CONFIG_CONTROL_CHANNEL, JSON.stringify(record));

    this.logger.warn({ message: 'Live documentation engine kill-switch updated', enabled, updatedBy, reason: actor?.reason ?? null });

    return {
      enabled,
      envDefault: this.enabled,
      source: 'redis-override',
      updatedAt,
      updatedBy: updatedBy ?? undefined,
    };
  }
}
