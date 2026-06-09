import { Inject, Injectable, Logger, type MessageEvent, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, type Subscription, finalize, interval, map, merge, takeWhile } from 'rxjs';
import { ContextItemEntity, ContextItemFactory, ContextItemRepository } from '@arcaai/domains';
import { IRedisCacheService } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { StreamingAudioBridgeService } from '../../stt/streaming/streamingAudioBridge.service';
import { mapSmrGenerateResponse } from '../summary/smr-v2-generate';
import { ConsultationPipelineEvent, type ContextAddedPayload, type ContextRemovedPayload } from '../events';
import {
  LiveDocEngineConfigResponse,
  LiveDocSessionStatsResponse,
  LiveDocSessionsListResponse,
  LiveSummaryEntityDto,
  LiveSummaryEventDto,
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
  /** Marks which process owns a session's lock so a foreign-instance stop can release it (P1-A). */
  private readonly instanceId = `${process.pid}-${Date.now()}`;

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

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @Inject(IRedisCacheService) private readonly cacheService: IRedisCacheService,
    private readonly redisSubscriber: RedisSubscriberService,
    @Optional() private readonly audioBridge?: StreamingAudioBridgeService,
    @Optional() @Inject(ContextItemRepository) private readonly contextItemRepository?: ContextItemRepository,
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
      finalPayload = await this.flush(consultationId, { force: true }).catch((error) => {
        this.logger.warn({ message: 'Final flush failed on stop', consultationId, error: error instanceof Error ? error.message : String(error) });
        return session.lastPayload ?? null;
      });

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

    // Tell the (possibly remote) owner to tear down, then release the lock, BEFORE the
    // terminal marker so SSE clients see `closed` last.
    await this.safeChannelPublish(this.controlChannel(consultationId), JSON.stringify({ type: 'stop', ts: new Date().toISOString() }));
    try {
      await this.cacheService.del(this.lockKey(consultationId));
    } catch (error) {
      this.logger.warn({ message: 'Failed to release live-doc owner lock', consultationId, error: error instanceof Error ? error.message : String(error) });
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
    session.contextNotes.push({ contextItemId: payload.contextItemId, text });
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
    const flushUpTo = session.transcriptParts.length;
    let delta = session.transcriptParts.slice(session.flushedTranscriptCount, flushUpTo).join(' ').trim();
    if (delta.length > MAX_DELTA_CHARS) delta = delta.slice(-MAX_DELTA_CHARS);
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
      const smrText = await this.callSmr(promptText, signal);
      smrLatencyMs = Date.now() - smrStartedAt;
      if (isStale()) return this.dropStale(session);
      const parsed = parseSoapJson(smrText) ?? parseSoapSections(smrText);
      if (parsed.length > 0) {
        sections = parsed;
        runningSummary = buildRunningSummary(parsed);
        session.flushedTranscriptCount = flushUpTo; // advance cursor only on success
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

    const payload: LiveSummaryEventDto = {
      consultationId,
      runningSummary,
      sections,
      entities,
      lastSegmentId: session.lastSegmentId,
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
   * Claim the single-owner lock and subscribe to the cross-instance control channel
   * (TASK-340 P1-A). Best-effort: the lock marks ownership and auto-expires, and a
   * `stop` from any instance publishes a `stop` control message this owner reacts to.
   *
   * Resilient-subset scope: we do NOT yet refuse to start when the lock is held by a
   * live foreign instance (that full single-owner enforcement + Redis-resident session
   * state is the documented remaining gap), but lock release + control-driven teardown
   * make a cross-instance `stop` correct for the current single-instance deployment.
   */
  private async claimOwnership(session: LiveSession): Promise<void> {
    try {
      await this.cacheService.set(this.lockKey(session.consultationId), this.instanceId, this.LOCK_TTL);
    } catch (error) {
      this.logger.warn({ message: 'Failed to claim live-doc owner lock', consultationId: session.consultationId, error: error instanceof Error ? error.message : String(error) });
    }

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
    session.abortController?.abort();
    session.sttSubscription?.unsubscribe();
    session.controlSubscription?.unsubscribe();
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
        const entity = ContextItemFactory.CreatePreSummary(session.tenantId, session.consultationId, content, undefined, session.userId ?? 'system');
        entity.metaData = metaData;
        await this.contextItemRepository.create(entity);
        session.snapshotEntity = entity;
        session.snapshotId = entity.id;
        this.logger.log({ message: 'Created live SOAP durable snapshot', consultationId: session.consultationId, contextItemId: entity.id });
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

  private async callSmr(promptText: string, signal?: AbortSignal): Promise<string> {
    // `response_format: json_schema` makes json-schema-capable providers return a
    // deterministic SOAP object (parsed by parseSoapJson); ollama ignores it so we
    // omit it there and fall back to the prose regex parse (P0-C).
    const includeResponseFormat = (this.smrProvider ?? '').toLowerCase() !== 'ollama';
    const payload = {
      prompt: promptText,
      system_prompt:
        'You are a clinical documentation assistant generating an in-progress, structured SOAP running note. Be concise and faithful to the transcript; never fabricate findings.',
      provider: this.smrProvider,
      model: this.smrModel,
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
    const raw = (response.data?.entities ?? []) as Array<{ type?: string; value?: string; confidence?: number; start?: number; end?: number }>;
    return raw.map((e) => ({
      text: e.value ?? '',
      type: e.type ?? 'UNKNOWN',
      confidence: e.confidence,
      start: e.start,
      end: e.end,
    }));
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
