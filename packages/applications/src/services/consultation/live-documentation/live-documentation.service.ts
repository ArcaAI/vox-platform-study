import { Inject, Injectable, Logger, type MessageEvent, OnModuleDestroy, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, type Subscription, finalize, interval, map, merge, takeWhile } from 'rxjs';
import { ContextItemFactory, ContextItemRepository } from '@arcaai/domains';
import { IRedisCacheService } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { StreamingAudioBridgeService } from '../../stt/streaming/streamingAudioBridge.service';
import { mapSmrGenerateResponse } from '../summary/smr-v2-generate';
import { ConsultationPipelineEvent, type ContextAddedPayload } from '../events';
import { LiveSummaryEntityDto, LiveSummaryEventDto } from './dto';
import { buildRunningSummary, parseSoapSections } from './soap-parser';

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
  contextNotes: string[];
  pendingSegments: number;
  segmentCounter: number;
  lastSegmentId?: string;
  timer?: ReturnType<typeof setTimeout>;
  lastPayload?: LiveSummaryEventDto;
  sttSubscription?: Subscription;
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
export class LiveDocumentationService implements OnModuleDestroy {
  private readonly logger = new Logger(LiveDocumentationService.name);
  private readonly sessions = new Map<string, LiveSession>();

  private readonly CHANNEL_PREFIX = 'consultation:live-summary:';
  private readonly SNAPSHOT_TTL = 3600; // 1h — transient last-snapshot for SSE late-join

  private readonly nlpServiceUrl: string;
  private readonly smrServiceUrl: string;
  private readonly segmentThreshold: number;
  private readonly debounceMs: number;
  private readonly heartbeatMs: number;

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
  }

  async onModuleDestroy(): Promise<void> {
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
    };
    this.sessions.set(params.consultationId, session);

    if (params.sessionId) {
      this.attachSttStream(session, params.sessionId);
    }

    this.logger.log({ message: 'Live documentation session started', consultationId: params.consultationId, sessionId: params.sessionId });
  }

  isActive(consultationId: string): boolean {
    return this.sessions.has(consultationId);
  }

  /**
   * Stop watching: flush a final snapshot, optionally persist it as a
   * PRE_SUMMARY, publish a terminal `closed` marker, and tear the session down.
   */
  async stop(consultationId: string, opts?: { persistSnapshot?: boolean }): Promise<LiveSummaryEventDto | null> {
    const session = this.sessions.get(consultationId);
    if (!session) return null;

    const finalPayload = await this.flush(consultationId).catch((error) => {
      this.logger.warn({ message: 'Final flush failed on stop', consultationId, error: error instanceof Error ? error.message : String(error) });
      return session.lastPayload ?? null;
    });

    if (opts?.persistSnapshot && this.contextItemRepository && finalPayload?.runningSummary?.trim()) {
      try {
        const preSummary = ContextItemFactory.CreatePreSummary(session.tenantId, consultationId, finalPayload.runningSummary, undefined, session.userId ?? 'system');
        await this.contextItemRepository.create(preSummary);
        this.logger.log({ message: 'Persisted live summary snapshot as PRE_SUMMARY', consultationId });
      } catch (error) {
        this.logger.warn({ message: 'Failed to persist PRE_SUMMARY snapshot', consultationId, error: error instanceof Error ? error.message : String(error) });
      }
    }

    this.clearTimer(session);
    session.sttSubscription?.unsubscribe();
    if (session.sessionId) {
      this.audioBridge?.unsubscribeFromResults(session.sessionId);
    }

    // Terminal marker so SSE clients can close gracefully.
    const closed: LiveSummaryEventDto = {
      ...(finalPayload ?? this.emptyPayload(consultationId)),
      closed: true,
    };
    await this.safePublish(consultationId, closed);

    this.sessions.delete(consultationId);
    this.logger.log({ message: 'Live documentation session stopped', consultationId });
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
    session.contextNotes.push(note ? `${label}${note}` : `${label}${payload.contextType} added`);
    this.scheduleFlush(session);
  }

  // ------------------------------------------------------------------
  // Flush — SMR + NLP aggregation, publish
  // ------------------------------------------------------------------

  /**
   * Recompute the running summary + entities and publish them. Public so the
   * debounce paths and `stop()` can invoke it (and so it is unit-testable).
   */
  async flush(consultationId: string): Promise<LiveSummaryEventDto | null> {
    const session = this.sessions.get(consultationId);
    if (!session) return null;
    this.clearTimer(session);

    const transcript = session.transcriptParts.join(' ').trim();
    const notes = session.contextNotes.join('\n').trim();
    if (!transcript && !notes) return null;

    session.pendingSegments = 0;

    const promptText = [transcript, notes ? `Clinician notes / labs:\n${notes}` : ''].filter(Boolean).join('\n\n');

    // SMR first (a structured S/O/A/P running note), then NER over the resulting
    // `runningSummary`. The summary is the canonical text the entity highlight
    // offsets index, so it must be produced before NER runs (sequential, not
    // parallel). Both calls retain the last-good value if the service is down.
    let sections = session.lastPayload?.sections ?? [];
    let runningSummary = session.lastPayload?.runningSummary ?? '';
    try {
      const parsed = parseSoapSections(await this.callSmr(promptText));
      if (parsed.length > 0) {
        sections = parsed;
        runningSummary = buildRunningSummary(parsed);
      }
    } catch (error) {
      this.logger.warn({ message: 'SMR running-summary call failed', consultationId, error: error instanceof Error ? error.message : String(error) });
    }

    let entities = session.lastPayload?.entities ?? [];
    try {
      entities = runningSummary ? await this.callNlp(runningSummary) : [];
    } catch (error) {
      this.logger.warn({ message: 'NLP entity call failed', consultationId, error: error instanceof Error ? error.message : String(error) });
    }

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
    return payload;
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

  private clearTimer(session: LiveSession): void {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = undefined;
    }
  }

  private async callSmr(text: string): Promise<string> {
    const payload = {
      prompt:
        'You are assisting a clinician during a live consultation. From the transcript and any clinician notes/labs so far, produce a concise, factual running clinical note structured as SOAP. ' +
        'Output EXACTLY these four sections, each header on its own line, in this order, and nothing else:\n\n' +
        'Subjective: <patient-reported history and symptoms>\n' +
        'Objective: <exam findings, vitals, labs>\n' +
        'Assessment: <clinical impressions / diagnoses>\n' +
        'Plan: <next steps, medications, follow-up>\n\n' +
        'Leave a section blank after its header if there is nothing yet. Do not invent details or add other sections.\n\n' +
        `Transcript so far:\n${text}`,
      system_prompt:
        'You are a clinical documentation assistant generating an in-progress, structured SOAP running note. Be concise and faithful to the transcript; never fabricate findings.',
      stream: false as const,
    };
    const response = await this.httpService.axiosRef.post(`${this.smrServiceUrl}/api/v1/generate`, payload, {
      timeout: 60000,
      headers: { 'Content-Type': 'application/json' },
    });
    return mapSmrGenerateResponse(response.data).summary;
  }

  private async callNlp(text: string): Promise<LiveSummaryEntityDto[]> {
    const response = await this.httpService.axiosRef.post(
      `${this.nlpServiceUrl}/api/v1/classify/tokens`,
      { text },
      { timeout: 30000 },
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
}
