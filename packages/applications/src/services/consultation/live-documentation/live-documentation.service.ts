import { Inject, Injectable, Logger, type MessageEvent, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Observable, ReplaySubject, type Subscription, filter, interval, map, merge, takeWhile } from 'rxjs';
import { AgentSessionKind, AgentStepStatus, AgentStepType, ContextItemEntity, ContextItemFactory, ContextItemRepository } from '@arcaai/domains';
import { IRedisCacheService } from '../../baseServices/redis';
import { IAgentTrajectoryService } from '../../agent-trajectory/IAgentTrajectoryService';
import type { CreateAgentTrajectoryStepInput } from '../../agent-trajectory/dto';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { encryptPhiFields } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { StreamingAudioBridgeService } from '../../stt/streaming/streamingAudioBridge.service';
import { mapSmrGenerateResponse } from '../summary/smr-generate';
import { HarnessPolicyService } from '../../harness-policy/harness-policy.service';
import { IAiTaskDefaultService } from '../../ai-task-default/IAiTaskDefaultService';
import { resolveNerModelInjection } from '../shared/resolveNerModelSelection';
import { ConsultationPipelineEvent, type ContextAddedPayload, type ContextRemovedPayload } from '../events';
import {
  LiveDocEngineConfigResponse,
  LiveDocSessionStatsResponse,
  LiveDocSessionsListResponse,
  LiveSummaryEntityDto,
  LiveSummaryEventDto,
  LiveSummaryGroundednessDto,
  LiveSummaryVitalsDto,
  LiveSummaryGroundednessSegmentDto,
  LiveSummaryStatsDto,
} from './dto';
import { LIVE_SOAP_RESPONSE_FORMAT, buildRunningSummary, parseSoapJson, parseSoapSections } from './soap-parser';
import { generateJsonWithRepair, looksLikeJsonObject } from '../shared/bounded-json-repair';
import type { LiveSummarySectionDto } from './dto';
import {
  AGENTIC_CONTEXT_DEFAULTS,
  AGENTIC_CONTEXT_KEY_PREFIX,
  type AgenticTranscriptMode,
} from '../../settings-registry/descriptors/agentic-context.descriptors';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';

// F-28: defensive caps on the append-only `LiveSession.transcriptParts` buffer.
// A pathological/runaway session (mic left open past `stop()`) would otherwise
// grow it unbounded — windowing/truncation (see `bounded transcript cost`)
// only bounds what's SENT per flush, not the underlying array's growth. WARN
// once past this many finals (still fully served); refuse to append past the
// hard cap (protects process memory).
const TRANSCRIPT_PARTS_WARN_THRESHOLD = 10_000;
const TRANSCRIPT_PARTS_HARD_CAP = 50_000;

/** Shared SOAP output instruction — describes the four sections for prose-only providers. */
const SOAP_OUTPUT_INSTRUCTION =
  'Output EXACTLY these four sections, each header on its own line, in this order, and nothing else:\n\n' +
  'Subjective: <patient-reported history and symptoms>\n' +
  'Objective: <exam findings, vitals, labs>\n' +
  'Assessment: <clinical impressions / diagnoses>\n' +
  'Plan: <next steps, medications, follow-up>\n\n' +
  'Leave a section blank after its header if there is nothing yet. Do not invent details or add other sections.';

/**
 * stable, prefix-cache-friendly lead-in for the live SMR
 * user prompt. This block is BYTE-IDENTICAL on every flush of a session (first
 * flush AND every subsequent update flush), so a prefix-cache engine (vLLM /
 * llama.cpp `cache_prompt`) reuses the KV cache of the stable prefix instead of
 * re-prefilling a mode-specific directive. `buildSmrUserPrompt` emits the blocks
 * in the order `[stable system] + [transcript-so-far] + [current note] +
 * [delta instruction]`, keeping the variable, mode-specific directive LAST.
 */
export const LIVE_SOAP_STABLE_SYSTEM_PREFIX =
  'You are assisting a clinician during a live consultation, maintaining a concise, factual ' +
  'running clinical note structured as SOAP. ' +
  SOAP_OUTPUT_INSTRUCTION;

/**
 * Safety cap on the transcript delta sent per flush (sliding-window fallback):
 * the incremental prompt only sends new transcript since the last successful
 * flush, but if SMR keeps failing the un-flushed delta grows — this bounds it
 * so a busy/failing session can't send an unbounded prompt.
 *
 * This former hardcoded constant is now the
 * `agentic.context.liveDelta.maxChars` settings-registry knob. The value is
 * resolved onto `this.contextLiveDeltaMaxChars` in the constructor (env override
 * → registry code default) so the cap is admin-controllable.
 */

/**
 * Atomic single-owner lock scripts. Redis serialises each Lua
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

/**
 * One SMR `/generate` call result for the bounded JSON auto-repair coordinator
 *. `structured` reflects whether `response_format:
 * json_schema` was actually sent (false for engines like Ollama that ignore it,
 * so a corrective retry is skipped); `latencyMs` is captured per-call so both the
 * original and the repair are recorded as ordered LLM_CALL trajectory steps.
 */
interface LiveSoapCall {
  text: string;
  stats: LiveSummaryStatsDto | null;
  structured: boolean;
  latencyMs: number;
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
  /** F-28: true once a warn-threshold log has fired for `transcriptParts` (fire once, not per-append). */
  transcriptPartsWarned: boolean;
  /** F-28: true once a hard-cap-reached error log has fired for `transcriptParts` (fire once, not per-refusal). */
  transcriptPartsCapLogged: boolean;
  /**
   * Live-folded notes/labs/files, keyed by their `contextItemId` so a
   * soft-delete can drop the exact entry. Insertion order is
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
  /** Cross-instance "stop" control-channel reader. */
  controlSubscription?: Subscription;
  /** Periodic fenced owner-lock renewal handle. */
  lockRenewalTimer?: ReturnType<typeof setInterval>;
  /** Monotonic flush id; only the latest generation may publish. */
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
  /** Epoch ms when the watcher session started — surfaced in the admin stats snapshot. */
  startedAt: number;
  /**
 * §2C — stable, per-instance trajectory session id used as the
   * `sessionId` on every emitted step. Distinct across stop→restart of the same
   * consultation so the `(tenantId, sessionId, runId, seq)` composite-unique key
   * never collides (which would make `skipDuplicates` silently drop the restarted
   * session's steps). Set once at creation and NEVER reassigned when a later STT
   * stream attaches, so grouping stays stable for the session's whole lifetime.
   */
  trajectorySessionId: string;
 /** §2C — monotonic trajectory-step sequence within this LIVE_DOC session. */
  trajectorySeq: number;
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
/** The effective `agentic.context.*` knobs for one resolution. */
export interface AgenticContextKnobs {
  liveDeltaMaxChars: number;
  segmentThreshold: number;
  idleMs: number;
  transcriptMode: AgenticTranscriptMode;
  tokenBudgetPerRun: number;
}

/** Read a numeric env override, treating unset/blank/non-numeric as "no override". */
function readNumericEnv(configService: ConfigService, key: string): number | undefined {
  const raw = configService.get(key);
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toTranscriptMode(raw: unknown): AgenticTranscriptMode {
  return String(raw) === 'windowed' ? 'windowed' : 'whole';
}

/**
 * A registry-STORED numeric value, or undefined when the facade fell through to
 * the code default (so the caller's env fallback can win) or when the stored value
 * is unusable. A wrong-typed stored value must never become NaN on the hot path.
 */
function storedNumber(result: { value: unknown; sourceScope: string }): number | undefined {
  if (result.sourceScope === 'code-default') return undefined;
  const parsed = Number(result.value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function storedMode(result: { value: unknown; sourceScope: string }): AgenticTranscriptMode | undefined {
  if (result.sourceScope === 'code-default') return undefined;
  return result.value === 'windowed' || result.value === 'whole' ? result.value : undefined;
}

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
   * never confuse two owners.
   */
  private readonly instanceId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  /** Renew the owner lock at half its TTL so a live session never lets it lapse (C5-06). */
  private readonly lockRenewalMs = Math.floor((this.LOCK_TTL * 1000) / 2);

  // Admin live console: cross-instance per-session stats in Redis.
  private readonly STATS_PREFIX = 'live-doc:stats:'; // + consultationId → JSON LiveDocSessionStatsResponse
  private readonly ACTIVE_SET_PREFIX = 'live-doc:active:'; // + tenantId → Set<consultationId>
  // Runtime kill-switch override (read at start, toggled by the admin console).
  private readonly CONFIG_ENABLED_KEY = 'live-doc:config:enabled'; // JSON { enabled, updatedAt, updatedBy, reason }
  private readonly CONFIG_CONTROL_CHANNEL = 'live-doc:config:control'; // cross-instance toggle fan-out

  /**
   * In-memory mirror of the Redis kill-switch override. `null` =
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
  private readonly heartbeatMs: number;
  // `agentic.context.*` env FALLBACKS. These are no longer the
  // effective values: the authority is the settings registry, resolved per call
  // through `resolveAgenticContext`'s `EffectiveSettingsService`.
  //
  // These six used to be read from `env ?? AGENTIC_CONTEXT_DEFAULTS` in the
  // constructor and frozen there — so a global admin's registry write moved what
  // `GET /admin/settings/registry` reported and moved NOTHING in the running loop,
  // and even the env value needed a redeploy. `undefined` here means "no env
  // override", which lets a stored value or the code default win.
  private readonly envSegmentThreshold?: number;
  private readonly envDebounceMs?: number;
  private readonly envLiveDeltaMaxChars?: number;
  private readonly envTranscriptMode?: AgenticTranscriptMode;
  private readonly envTokenBudgetPerRun?: number;
  /**
   * Most recently resolved knobs, refreshed by every `resolveAgenticContext` call.
   *
   * The flush path resolves fresh; the two SYNCHRONOUS consumers (`ingestSegment`'s
   * threshold check and `scheduleFlush`'s debounce) read this snapshot, because
   * they cannot await. That yields exactly the contract the control plane promises:
   * a registry change is picked up by the NEXT flush, and the sync paths follow it
   * from then on. Seeded from env/defaults so behaviour before the first flush is
   * identical to pre-B1.
   */
  private lastAgenticContext: AgenticContextKnobs;
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
    // Resolver for the tenant's effective SMR {provider, model}.
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // X-Service-Token for the guardrail groundedness hop
    // (SecretsService is provided by the @Global SecretsModule). Optional so unit
    // fixtures and non-DI construction paths compile; when unset an empty token is
    // sent (the guardrail's empty-token dev bypass).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // §2C — ordered per-flush trajectory emitter. Optional + trailing so
    // existing positional test fixtures and non-DI paths compile; production DI
    // (apps/api consultation module) supplies it. A trajectory failure is
    // fire-and-forget and can NEVER break the live flush (see recordFlushTrajectory).
    @Optional() @Inject(IAgentTrajectoryService) private readonly trajectoryService?: IAgentTrajectoryService,
    // Governed read facade for `agentic.context.*`.
    // Optional + trailing so existing positional fixtures keep their arity; absent
    // ⇒ env/code-default resolution.
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
    // Resolves the effective `nlp.ner` AiTaskDefault model for injection into
    // the live-plane NLP call (TASK-552 Lane A). Optional + trailing so
    // existing positional fixtures keep their arity; absent ⇒ posts without
    // `model_name`, i.e. today's behavior (fail-open).
    @Optional() @Inject(IAiTaskDefaultService) private readonly aiTaskDefaultService?: IAiTaskDefaultService,
    // CLS accessor for the SYSTEM-pin the resolver needs (this service is not
    // otherwise request-scoped). `ClsService` is provided by the globally-
    // registered `ClsModule` (see the class doc above). Optional + trailing so
    // existing positional fixtures keep their arity; absent ⇒ the resolver call
    // is skipped defensively — see `callNlp`.
    @Optional() private readonly cls?: ClsService<IActiveUserContext>,
  ) {
    this.nlpServiceUrl = this.configService.get<string>('NLP_URL') ?? 'http://localhost:8864';
    this.smrServiceUrl = this.configService.get<string>('SMR_URL') ?? 'http://localhost:8862';
    // Capture only the ENV OVERRIDES here. The effective values are
    // resolved per call in `resolveAgenticContext` so a control-plane write lands
    // on the next flush with no redeploy. `LIVE_DOC_*` keys stay supported as the
    // operational lane, but they now LOSE to a stored registry value.
    this.envSegmentThreshold = readNumericEnv(this.configService, 'LIVE_DOC_SEGMENT_THRESHOLD');
    this.envDebounceMs = readNumericEnv(this.configService, 'LIVE_DOC_DEBOUNCE_MS');
    this.envLiveDeltaMaxChars = readNumericEnv(this.configService, 'AGENTIC_CONTEXT_LIVE_DELTA_MAX_CHARS');
    this.envTokenBudgetPerRun = readNumericEnv(this.configService, 'AGENTIC_CONTEXT_TOKEN_BUDGET_PER_RUN');
    const rawMode = this.configService.get('AGENTIC_CONTEXT_TRANSCRIPT_MODE');
    this.envTranscriptMode = rawMode === undefined || rawMode === null ? undefined : toTranscriptMode(rawMode);
    this.lastAgenticContext = this.envFallbackContext();
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
    // TTL on the per-session Redis stats snapshot + active set. A
    // crashed/quiet session falls out of the admin "live" list after this window;
    // refreshed on every flush so an actively-flushing session stays visible.
    this.statsTtl = Number(this.configService.get('LIVE_DOC_STATS_TTL_SEC') ?? 300);
    // Output groundedness gate. Off by default (dev/CI bypass); enabling is
    // the clinical/ops rollout
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
   * Boot-time kill-switch wiring: seed the in-memory override
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
    // Feature kill-switch: never spin up a watcher when
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

    const startedAt = Date.now();
    const session: LiveSession = {
      consultationId: params.consultationId,
      tenantId: params.tenantId,
      userId: params.userId,
      sessionId: params.sessionId,
      transcriptParts: [],
      transcriptPartsWarned: false,
      transcriptPartsCapLogged: false,
      contextNotes: [],
      pendingSegments: 0,
      segmentCounter: 0,
      generation: 0,
      flushedTranscriptCount: 0,
      lastFlushAt: 0,
      lastDurableAt: startedAt,
      flushCount: 0,
      staleDropCount: 0,
      truncatedDeltaCount: 0,
      startedAt,
      trajectorySessionId: params.sessionId ?? `${params.consultationId}:${startedAt}`,
      trajectorySeq: 0,
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
   * Stop watching. Resilient + cross-instance correct: when this
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

    // Drop this session from the admin live view (stats key +
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
    // release.
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

    // F-28: defensive caps — refuse to grow the buffer past the hard cap
    // (protects process memory on a pathological/runaway session).
    if (session.transcriptParts.length >= TRANSCRIPT_PARTS_HARD_CAP) {
      if (!session.transcriptPartsCapLogged) {
        session.transcriptPartsCapLogged = true;
        this.logger.error({
          message: 'transcriptParts hard cap reached — refusing further finals',
          consultationId,
          transcriptPartsCount: session.transcriptParts.length,
          cap: TRANSCRIPT_PARTS_HARD_CAP,
        });
      }
      return;
    }

    session.transcriptParts.push(text);

    if (session.transcriptParts.length > TRANSCRIPT_PARTS_WARN_THRESHOLD && !session.transcriptPartsWarned) {
      session.transcriptPartsWarned = true;
      this.logger.warn({
        message: 'transcriptParts exceeded warn threshold — pathological session?',
        consultationId,
        transcriptPartsCount: session.transcriptParts.length,
        warnThreshold: TRANSCRIPT_PARTS_WARN_THRESHOLD,
      });
    }

    session.pendingSegments += 1;
    session.segmentCounter += 1;
    session.lastSegmentId = segment.segmentId ?? `seg-${session.segmentCounter}`;

    if (session.pendingSegments >= this.lastAgenticContext.segmentThreshold) {
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

    // UPSERT by contextItemId: the OCR enrichment processor re-emits
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
   * Context-remove reaction: a note/lab/file soft-deleted
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
   * publish, advance the incremental cursor, or persist.
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

    // Resolve the effective agentic.context.* knobs for THIS flush.
    // Refreshing here (rather than at construction) is what makes the control plane
    // real: a global admin's registry write governs the very next flush, with no
    // redeploy. It also refreshes the snapshot the synchronous ingest/debounce
    // paths read.
    const agenticContext = await this.resolveAgenticContext(session.tenantId);

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
    const windowed = agenticContext.transcriptMode === 'windowed';
    const deltaSegments: string[] = [];
    let deltaEnd = session.flushedTranscriptCount;
    let deltaLen = 0;
    let deltaTruncated = false;
    let elidedParts = 0;

    if (windowed) {
      // Windowed mode: take the most RECENT segments that fit.
      //
      // The prior SOAP note already carries everything older, so on overflow the
      // oldest backlog largely re-describes what the note has while the NEWEST
      // content is precisely what it lacks. Walk backwards from the tail, then
      // restore chronological order for the prompt.
      //
      // The cursor advances over the WHOLE backlog (`deltaEnd = flushUpTo`):
      // unlike `whole` mode there is no carry-forward, because a skipped head
      // would only get older and lose again on the next flush. That is a real
      // trade — elided transcript is not re-sent — so the prompt says so
      // explicitly rather than presenting a partial window as the full encounter.
      for (let i = flushUpTo - 1; i >= session.flushedTranscriptCount; i--) {
        const part = session.transcriptParts[i];
        const separator = deltaSegments.length > 0 ? 1 : 0;
        if (deltaSegments.length > 0 && deltaLen + separator + part.length > agenticContext.liveDeltaMaxChars) {
          deltaTruncated = true;
          break;
        }
        deltaSegments.unshift(part);
        deltaLen += separator + part.length;
      }
      elidedParts = flushUpTo - session.flushedTranscriptCount - deltaSegments.length;
      deltaEnd = flushUpTo;
    } else {
      for (let i = session.flushedTranscriptCount; i < flushUpTo; i++) {
        const part = session.transcriptParts[i];
        const separator = deltaSegments.length > 0 ? 1 : 0; // the joining space
        // The `deltaSegments.length > 0` guard always admits the FIRST segment so the
        // cursor can always advance (no stall). Consequently the cap is a
        // SOFT per-flush bound — a single segment larger than the cap is still sent whole.
        if (deltaSegments.length > 0 && deltaLen + separator + part.length > agenticContext.liveDeltaMaxChars) {
          deltaTruncated = true;
          break; // stop at the head boundary — the rest carries forward
        }
        deltaSegments.push(part);
        deltaLen += separator + part.length;
        deltaEnd = i + 1;
      }
    }

    const delta = deltaSegments.join(' ').trim();
    if (deltaTruncated) {
      session.truncatedDeltaCount += 1;
      // PHI-safe: sizes/counts only — never transcript text.
      this.logger.warn({
        message: windowed
          ? 'Live summary transcript windowed — older backlog elided (TASK-533 B3)'
          : 'Live summary transcript delta truncated — carrying overflow forward (C5-04)',
        consultationId,
        truncatedDeltaCount: session.truncatedDeltaCount,
        deltaChars: delta.length,
        carriedForwardParts: flushUpTo - deltaEnd,
        elidedParts,
      });
    }
    const priorNote = session.lastPayload?.runningSummary ?? '';
    const promptText = this.buildSmrUserPrompt(priorNote, delta || transcript, notes, elidedParts > 0);

    // SMR first (a structured S/O/A/P running note), then NER over the resulting
    // `runningSummary` (the canonical text the entity highlight offsets index — so it
    // must be produced before NER runs). Both calls retain the last-good value if the
    // service is down.
    let sections = session.lastPayload?.sections ?? [];
    let runningSummary = priorNote;
    let smrFailed = false;
    let smrLatencyMs = 0;
    // AD-1 generation stats for this flush (null unless SMR
    // returned a stats block); surfaced on the payload as `metadata.stats`.
    let smrStats: LiveSummaryStatsDto | null = null;
    // bounded JSON auto-repair telemetry. When the first
    // structured response is not valid SOAP JSON we do EXACTLY ONE corrective
    // retry; the repair SMR call is recorded as its own ordered LLM_CALL step.
    let smrRepaired = false;
    let repairLatencyMs = 0;
    let repairStats: LiveSummaryStatsDto | null = null;
    try {
      // Bounded JSON auto-repair: the strict parser is `parseSoapJson` (null on a
      // JSON/shape failure); the tolerant `parseSoapSections` regex parser is the
      // final fallback. A retry only runs when `response_format` was actually
      // sent (structured) — an engine that ignores it returns prose by design, so
      // a retry could never yield JSON and is skipped. The corrective instruction
      // is appended (not prepended) to keep the prefix-cache-stable lead-in intact.
      const outcome = await generateJsonWithRepair<LiveSummarySectionDto[], LiveSoapCall>({
        generate: async (corrective) => {
          const startedAt = Date.now();
          const { text, stats, structured } = await this.callSmr(promptText, session.tenantId, signal, corrective);
          return { text, stats, structured, latencyMs: Date.now() - startedAt };
        },
        parseStrict: (text) => {
          const parsed = parseSoapJson(text);
          return parsed && parsed.length > 0 ? parsed : null;
        },
        parseTolerant: (text) => parseSoapSections(text),
        // Retry only a genuine malformed-JSON attempt: structured output was
        // requested AND the text opens a JSON object. Clean prose (no leading
        // `{`) is served by the tolerant regex parser with no wasted regen.
        shouldRepair: (first) => first.structured && looksLikeJsonObject(first.text),
      });
      if (isStale()) return this.dropStale(session);

      const [firstCall, repairCall] = outcome.calls;
      smrLatencyMs = firstCall.latencyMs;
      smrStats = firstCall.stats;
      smrRepaired = outcome.repaired;
      if (repairCall) {
        repairLatencyMs = repairCall.latencyMs;
        repairStats = repairCall.stats;
      }

      const parsed = outcome.value;
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

    // Extract-from-source + entity-ground (SPEER). Run NER over the RAW
    // TRANSCRIPT DELTA (the same `delta || transcript` that feeds SMR), NOT the generated note:
    // the LLM running note carries a material hallucination base rate, so NER over the note
    // laundered invented findings/medications into first-class clinical entities. The
    // transcript-sourced entities are then GROUNDED back to the rendered note (below) — a
    // mention that survives only in the note with no transcript support is never a candidate
    // here (NER never sees the note) and is therefore never surfaced.
    const nerSourceText = delta || transcript;
    const priorEntities = session.lastPayload?.entities ?? [];
    let extracted: LiveSummaryEntityDto[] = [];
    let flushVitals: LiveSummaryVitalsDto | undefined;
    let nlpFailed = false;
    let nlpLatencyMs = 0;
    const nlpStartedAt = Date.now();
    try {
      const nlpResult = nerSourceText ? await this.callNlp(nerSourceText, signal) : { entities: [] as LiveSummaryEntityDto[] };
      extracted = nlpResult.entities;
      flushVitals = nlpResult.vitals;
      nlpLatencyMs = Date.now() - nlpStartedAt;
    } catch (error) {
      if (isStale()) return this.dropStale(session);
      nlpFailed = true;
      this.logger.warn({ message: 'NLP entity call failed', consultationId, error: error instanceof Error ? error.message : String(error) });
    }

    if (isStale()) return this.dropStale(session);

    // Live OUTPUT groundedness gate: verify the generated note
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

    // Ground the union of prior + newly-extracted transcript entities against the CURRENT note
    // . Merging with the prior set preserves the running highlight set across flushes
    // (NER only sees the new delta, but the note is cumulative — recall), and always re-grounding
    // against the current `runningSummary` keeps offsets valid even on the NLP-failure fallback.
    const entities = this.groundEntitiesToNote([...priorEntities, ...extracted], runningSummary);
    // Vitals accumulate across flushes (NER only sees the new delta) — a later
    // non-null value wins, prior values persist. Absent until one is seen.
    const vitals = this.mergeVitals(session.lastPayload?.vitals, flushVitals);

    const payload: LiveSummaryEventDto = {
      consultationId,
      runningSummary,
      sections,
      entities,
      lastSegmentId: session.lastSegmentId,
      ...(groundedness ? { groundedness } : {}),
      // attach the AD-1 stats when present; omit the envelope
      // entirely on a stats-less flush (SMR failure / legacy cache hit) so the
      // feed degrades cleanly rather than publishing an empty metadata block.
      ...(smrStats ? { metadata: { stats: smrStats } } : {}),
      ...(vitals ? { vitals } : {}),
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
      // Verdict + latency only (PHI-safe; never the flagged text).
      groundednessVerdict: groundedness?.verdict,
      groundednessLatencyMs,
    });

    // Mirror the same PHI-safe metrics into Redis so the admin
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

    // §2C — emit the ordered per-flush trajectory. Non-fatal: a
    // trajectory failure NEVER breaks the live flush (recordFlushTrajectory
    // swallows + logs). Runs after the payload is published/persisted.
    await this.recordFlushTrajectory(session, {
      smrStats,
      smrFailed,
      smrLatencyMs,
      smrRepaired,
      repairStats,
      repairLatencyMs,
      nlpRan: !!nerSourceText,
      nlpFailed,
      nlpLatencyMs,
      groundedness,
      groundednessLatencyMs,
    });

    return payload;
  }

  /**
 * §2C — record the ordered trajectory for one flush:
   *   [LLM_CALL:flush, TOOL_CALL:nlp.classify-tokens (when NLP ran),
   *    GUARDRAIL:groundedness (when the gate ran), PHASE:publish].
   * sessionKind=LIVE_DOC, runId="" (non-Temporal sentinel), consultationId set,
   * seq monotonic within the session. Fire-and-forget: wrapped in try/catch so a
   * telemetry failure can never break the live flush the clinician depends on.
   */
  private async recordFlushTrajectory(
    session: LiveSession,
    ctx: {
      smrStats: LiveSummaryStatsDto | null;
      smrFailed: boolean;
      smrLatencyMs: number;
 /** whether the bounded JSON auto-repair retry ran. */
      smrRepaired: boolean;
      repairStats: LiveSummaryStatsDto | null;
      repairLatencyMs: number;
      nlpRan: boolean;
      nlpFailed: boolean;
      nlpLatencyMs: number;
      groundedness?: LiveSummaryGroundednessDto;
      groundednessLatencyMs: number;
    },
  ): Promise<void> {
    if (!this.trajectoryService) return;
    try {
      const now = Date.now();
      const common = {
        tenantId: session.tenantId,
        consultationId: session.consultationId,
        sessionKind: AgentSessionKind.LIVE_DOC,
        sessionId: session.trajectorySessionId,
        runId: '',
      } as const;

      const steps: CreateAgentTrajectoryStepInput[] = [];

      // 1) LLM_CALL — the SMR running-summary generation for this flush.
      steps.push({
        ...common,
        seq: session.trajectorySeq++,
        stepType: AgentStepType.LLM_CALL,
        name: 'flush',
        status: ctx.smrFailed ? AgentStepStatus.ERROR : AgentStepStatus.OK,
        startedAt: new Date(now - ctx.smrLatencyMs),
        endedAt: new Date(now),
        durationMs: ctx.smrLatencyMs,
        stats: (ctx.smrStats ?? undefined) as CreateAgentTrajectoryStepInput['stats'],
      });

      // 1b) LLM_CALL — the bounded JSON auto-repair retry,
      // recorded only when the corrective retry actually ran so the trajectory
      // reflects EXACTLY the SMR calls this flush made (original + at most one repair).
      if (ctx.smrRepaired) {
        steps.push({
          ...common,
          seq: session.trajectorySeq++,
          stepType: AgentStepType.LLM_CALL,
          name: 'flush.repair',
          status: AgentStepStatus.OK,
          startedAt: new Date(now - ctx.repairLatencyMs),
          endedAt: new Date(now),
          durationMs: ctx.repairLatencyMs,
          stats: (ctx.repairStats ?? undefined) as CreateAgentTrajectoryStepInput['stats'],
        });
      }

      // 2) TOOL_CALL — NLP token classification (only when it ran).
      if (ctx.nlpRan) {
        steps.push({
          ...common,
          seq: session.trajectorySeq++,
          stepType: AgentStepType.TOOL_CALL,
          name: 'nlp.classify-tokens',
          status: ctx.nlpFailed ? AgentStepStatus.ERROR : AgentStepStatus.OK,
          startedAt: new Date(now - ctx.nlpLatencyMs),
          endedAt: new Date(now),
          durationMs: ctx.nlpLatencyMs,
        });
      }

      // 3) GUARDRAIL — output groundedness gate (only when enabled/ran).
      if (ctx.groundedness) {
        steps.push({
          ...common,
          seq: session.trajectorySeq++,
          stepType: AgentStepType.GUARDRAIL,
          name: 'groundedness',
          status: AgentStepStatus.OK,
          startedAt: new Date(now - ctx.groundednessLatencyMs),
          endedAt: new Date(now),
          durationMs: ctx.groundednessLatencyMs,
          payloadRef: { verdict: ctx.groundedness.verdict },
        });
      }

      // 4) PHASE — publish to the live feed.
      steps.push({
        ...common,
        seq: session.trajectorySeq++,
        stepType: AgentStepType.PHASE,
        name: 'publish',
        status: AgentStepStatus.OK,
        startedAt: new Date(now),
        endedAt: new Date(now),
      });

      await this.trajectoryService.recordSteps(steps);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to record live-doc flush trajectory (non-fatal)',
        consultationId: session.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
   * SSE source for `GET /consultations/:id/live-summary/stream`. Subscribes to
   * the Redis channel FIRST (buffering through a ReplaySubject), then reads the
   * stored snapshot (late-join) and relays the buffered + live channel events —
   * de-duped against the snapshot by `updatedAt` — until the terminal
   * `closed: true`, with a periodic heartbeat so idle streams survive proxies.
   *
   * Two hazards this closes (both documented + solved identically in the sibling
   * `HarnessProgressService.subscribeToProgress`, ported here):
   *
   *   F-05 (snapshot-before-subscribe race): the old order read the snapshot
   *   and THEN subscribed, so any `safePublish` (including the terminal
   *   `closed`) that landed in the round-trip window was silently dropped for
   *   that viewer. Subscribe-first + buffer closes the window.
   *
   *   F-04 (shared-Subject teardown): the old finalize called
   *   `redisSubscriber.unsubscribeFromChannel(channel)` DIRECTLY, which
   *   unconditionally completes the SHARED per-channel Subject and starves every
   *   OTHER concurrent viewer of the same consultation (two tabs / a second
   *   clinician / a reconnect racing teardown). Teardown now relies EXCLUSIVELY
   *   on the refcounted finalize inside `subscribeToChannel` — releasing this
   *   viewer's bridge subscription decrements the refcount and only the LAST
   *   viewer out tears the Redis subscription down.
   */
  subscribeToLiveSummary(consultationId: string): Observable<MessageEvent> {
    const channel = this.channel(consultationId);

    return new Observable<MessageEvent>((subscriber) => {
      let inner: Subscription | null = null;
      let bridgeSub: Subscription | null = null;

      (async () => {
        const messages$ = await this.redisSubscriber.subscribeToChannel(channel);
        // Buffer channel events while the snapshot read is in flight; replayed
        // into the relay below so ordering stays snapshot-first.
        const bridge = new ReplaySubject<string>();
        bridgeSub = messages$.subscribe(bridge);

        const snapshot = await this.cacheService.get(this.snapshotKey(consultationId));
        const snapshotUpdatedAt = this.parseLiveSummaryUpdatedAt(snapshot);
        if (snapshot) {
          subscriber.next({ data: snapshot } as MessageEvent);
        }

        const relay$ = bridge.pipe(
          // De-dupe: safePublish stores the snapshot BEFORE publishing, so a
          // buffered event can be the very state the snapshot already carried.
          filter((raw: string) => !this.isDuplicateOfLiveSummarySnapshot(raw, snapshotUpdatedAt)),
          map((raw: string): MessageEvent => ({ data: raw }) as MessageEvent),
        );

        const heartbeat$ = interval(this.heartbeatMs).pipe(
          map((): MessageEvent => ({ data: JSON.stringify({ type: 'heartbeat', ts: new Date().toISOString() }) }) as MessageEvent),
        );

        // takeWhile sits on the MERGED stream (not just the relay) so the
        // terminal `closed` event completes the whole SSE stream — the infinite
        // heartbeat interval would otherwise keep `merge` alive.
        const stream$ = merge(relay$, heartbeat$).pipe(
          takeWhile((event: MessageEvent) => {
            try {
              return JSON.parse(event.data as string).closed !== true;
            } catch {
              return true;
            }
          }, true), // include the terminal `closed` event
        );

        inner = stream$.subscribe({
          next: (event) => subscriber.next(event),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      })().catch((error) => {
        this.logger.error({
          message: 'Failed to initialise live-summary SSE subscription',
          consultationId,
          error: error instanceof Error ? error.message : String(error),
        });
        subscriber.next({ data: JSON.stringify({ error: 'Failed to subscribe to live summary', consultationId }) } as MessageEvent);
        subscriber.complete();
      });

      return () => {
        inner?.unsubscribe();
        // Releasing the bridge drives the refcounted channel cleanup (last
        // viewer out tears the Redis subscription down).
        bridgeSub?.unsubscribe();
      };
    });
  }

  /** The `updatedAt` of a serialized live-summary snapshot; null when absent/corrupt. */
  private parseLiveSummaryUpdatedAt(snapshot: string | null | undefined): string | null {
    if (!snapshot) return null;
    try {
      const updatedAt = (JSON.parse(snapshot) as Partial<LiveSummaryEventDto>).updatedAt;
      return typeof updatedAt === 'string' ? updatedAt : null;
    } catch {
      return null;
    }
  }

  /**
   * True when a relayed channel event carries state the just-emitted snapshot
   * already contained (same or older `updatedAt` — ISO strings compare
   * lexicographically). Events without an `updatedAt` are relayed untouched.
   */
  private isDuplicateOfLiveSummarySnapshot(raw: string, snapshotUpdatedAt: string | null): boolean {
    if (!snapshotUpdatedAt) return false;
    const updatedAt = this.parseLiveSummaryUpdatedAt(raw);
    return updatedAt != null && updatedAt <= snapshotUpdatedAt;
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
    }, this.lastAgenticContext.idleMs);
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
   * channel.
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
        // restoring the single-owner invariant mid-session instead of only logging.
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
   * Throttled durable snapshot: upsert ONE PRE_SUMMARY row tagged
   * `metadata.subType = 'LIVE_SOAP_SNAPSHOT'` (create on first write, update the same
   * row thereafter) so the in-progress draft survives a restart/late join without
   * writing a row per tick. `force` (final-on-stop) bypasses the interval throttle.
   */
  /**
   * Encrypt the live SOAP snapshot's plaintext `content` into
   * `encryptedContent` / `contentKeyVersion` before persistence — mirrors
   * `context.service.ts#encryptContent` / `chain-summary.service.ts`. The
   * plaintext `content` column was dropped by the PHI field-encryption
   * migration, so a create/update that skips this silently loses the
   * clinical LIVE_SOAP_SNAPSHOT text at rest.
   */
  private async encryptSnapshotContent(entity: ContextItemEntity): Promise<void> {
    if (!this.contextItemRepository) return;
    await encryptPhiFields(
      this.secretsService,
      'ContextItem content',
      () => this.contextItemRepository!.encryptContentIntoEntity(entity, this.secretsService!),
      this.logger,
    );
  }

  private async persistDurableSnapshot(session: LiveSession, payload: LiveSummaryEventDto, opts: { force: boolean }): Promise<void> {
    if (!this.contextItemRepository) return;
    if (!opts.force && (this.durableSnapshotMs <= 0 || Date.now() - session.lastDurableAt < this.durableSnapshotMs)) return;

    const content = payload.runningSummary?.trim();
    if (!content) return;

    session.lastDurableAt = Date.now();
    const metaData = { subType: 'LIVE_SOAP_SNAPSHOT', lastSegmentId: session.lastSegmentId, updatedAt: payload.updatedAt };

    try {
      if (!session.snapshotEntity) {
        // Deterministic dedup: a prior tick — on THIS
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
          await this.encryptSnapshotContent(existing);
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
          await this.encryptSnapshotContent(entity);
          await this.contextItemRepository.create(entity);
          session.snapshotEntity = entity;
          session.snapshotId = entity.id;
          this.logger.log({ message: 'Created live SOAP durable snapshot', consultationId: session.consultationId, contextItemId: entity.id });
        }
      } else {
        session.snapshotEntity.content = content;
        session.snapshotEntity.metaData = metaData;
        await this.encryptSnapshotContent(session.snapshotEntity);
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
   * Assemble the live SMR user prompt. Once a SOAP note exists we
   * send it plus only the new transcript delta ("update the note") instead of the
   * whole transcript, keeping prompt size bounded; the first flush sends the delta
   * as the initial transcript.
   */
  private buildSmrUserPrompt(priorNote: string, delta: string, notes: string, elided = false): string {
    const notesBlock = notes ? `\n\nClinician notes / labs:\n${notes}` : '';
    const hasPriorNote = priorNote.trim().length > 0;
    // In windowed mode an over-cap backlog drops its oldest part.
    // Say so: a partial window presented as the whole encounter would invite the
    // model to treat absent findings as absent from the visit. Appended AFTER the
    // stable prefix, and only when something was actually elided, so both the
    // prefix-cache-stable lead-in and the `whole`-mode prompt stay untouched.
    const elisionBlock = elided
      ? '\n\nNOTE: earlier transcript from this update was elided to fit the context window; the SOAP note above already reflects it. Do not treat its absence as new information.'
      : '';

    // prefix-cache-friendly ordering:
    //   [stable system] + [transcript-so-far] + [current note] + [delta instruction]
    // The leading stable-system block is identical across the first flush and
    // every update flush (see LIVE_SOAP_STABLE_SYSTEM_PREFIX), so the engine
    // reuses the cached KV of that prefix. The mode-specific directive that
    // used to LEAD the prompt (breaking the shared prefix between first/update
    // flushes) is now the trailing block.
    const transcriptBlock = hasPriorNote
      ? `\n\nNew transcript since last update:\n${delta}`
      : `\n\nTranscript so far:\n${delta}`;
    const currentNoteBlock = hasPriorNote ? `\n\nCurrent SOAP note so far:\n${priorNote}` : '';
    const deltaInstruction = hasPriorNote
      ? '\n\nUpdate the existing SOAP note above using ONLY the new transcript since the last update; keep prior content unless it is contradicted.'
      : '\n\nFrom the transcript and any clinician notes/labs above, produce the running SOAP note now.';

    return LIVE_SOAP_STABLE_SYSTEM_PREFIX + transcriptBlock + currentNoteBlock + elisionBlock + deltaInstruction + notesBlock;
  }

  /**
   * Resolve the effective `agentic.context.*` knobs for `tenantId`.
   *
   * Precedence, highest first:
   *   1. a value STORED through the settings-registry write route (`sourceScope: 'global-kv'`)
   *   2. a `LIVE_DOC_*` / `AGENTIC_CONTEXT_*` env override
   *   3. the descriptor code default (`AGENTIC_CONTEXT_DEFAULTS`)
   *
   * Env deliberately LOSES to a stored value: the registry is the control plane,
   * and a knob a global admin can see in the catalog must be the knob that governs.
   * When nothing is stored, (2)/(3) reproduce the pre-B1 behaviour exactly, so an
   * untouched deployment is unaffected.
   *
   * Resolved PER CALL rather than cached on the instance — that constructor freeze
   * is precisely what made the control plane decorative. The underlying facade
   * reads an in-memory snapshot (`AppSettingsService`, refreshed on write and on a
   * 45s cron), so six lookups per flush cost no I/O. NOTE: because that snapshot is
   * per-instance, a write is immediate on the writing API instance and converges on
   * others within one cron tick.
   *
   * Never throws: a settings-backend failure degrades to env/defaults, because this
   * sits on the live flush path.
   */
  async resolveAgenticContext(tenantId: string): Promise<AgenticContextKnobs> {
    const fallback = this.envFallbackContext();
    if (!this.effectiveSettings) {
      this.lastAgenticContext = fallback;
      return fallback;
    }

    try {
      const ctx = { tenantId };
      const [delta, threshold, idle, mode, budget] = await Promise.all([
        this.effectiveSettings.resolveEffective(`${AGENTIC_CONTEXT_KEY_PREFIX}liveDelta.maxChars`, ctx),
        this.effectiveSettings.resolveEffective(`${AGENTIC_CONTEXT_KEY_PREFIX}liveFlush.segmentThreshold`, ctx),
        this.effectiveSettings.resolveEffective(`${AGENTIC_CONTEXT_KEY_PREFIX}liveFlush.idleMs`, ctx),
        this.effectiveSettings.resolveEffective(`${AGENTIC_CONTEXT_KEY_PREFIX}transcript.mode`, ctx),
        this.effectiveSettings.resolveEffective(`${AGENTIC_CONTEXT_KEY_PREFIX}tokenBudget.perRun`, ctx),
      ]);
      const resolved: AgenticContextKnobs = {
        liveDeltaMaxChars: storedNumber(delta) ?? fallback.liveDeltaMaxChars,
        segmentThreshold: storedNumber(threshold) ?? fallback.segmentThreshold,
        idleMs: storedNumber(idle) ?? fallback.idleMs,
        transcriptMode: storedMode(mode) ?? fallback.transcriptMode,
        tokenBudgetPerRun: storedNumber(budget) ?? fallback.tokenBudgetPerRun,
      };
      this.lastAgenticContext = resolved;
      return resolved;
    } catch (error) {
      this.logger.warn({
        message: 'agentic.context.* resolution failed — falling back to env/code defaults for this flush',
        error: error instanceof Error ? error.message : String(error),
      });
      this.lastAgenticContext = fallback;
      return fallback;
    }
  }

  /** The env-override → code-default knobs, i.e. the pre-B1 resolution. */
  private envFallbackContext(): AgenticContextKnobs {
    return {
      liveDeltaMaxChars: this.envLiveDeltaMaxChars ?? AGENTIC_CONTEXT_DEFAULTS['liveDelta.maxChars'],
      segmentThreshold: this.envSegmentThreshold ?? AGENTIC_CONTEXT_DEFAULTS['liveFlush.segmentThreshold'],
      idleMs: this.envDebounceMs ?? AGENTIC_CONTEXT_DEFAULTS['liveFlush.idleMs'],
      transcriptMode: this.envTranscriptMode ?? AGENTIC_CONTEXT_DEFAULTS['transcript.mode'],
      tokenBudgetPerRun: this.envTokenBudgetPerRun ?? AGENTIC_CONTEXT_DEFAULTS['tokenBudget.perRun'],
    };
  }

  private async callSmr(
    promptText: string,
    tenantId: string,
    signal?: AbortSignal,
    corrective?: string,
  ): Promise<{ text: string; stats: LiveSummaryStatsDto | null; structured: boolean }> {
    // SMR is a stateless gateway with no model default. Resolve the
    // tenant's effective {provider, model} via the HarnessPolicy cascade (NOT the
    // legacy LIVE_DOC_SMR_PROVIDER/MODEL env); fall back to env only when the
    // resolver is not wired (kept for non-DI construction paths).
    //
    // This is the LIVE tier: ask for the 'smr.live' routing key so a
    // global admin can point the low-latency running-note model at something smaller
    // than the end-of-visit finalize model. Omitting the task argument defaults to
    // 'finalize', which is what left `smr.live` inert despite being seeded+registered.
    let provider = this.smrProvider;
    let model = this.smrModel;
    if (this.harnessPolicyService) {
      ({ provider, model } = await this.harnessPolicyService.resolveSmrSelection(tenantId, 'live'));
    }
    // `response_format: json_schema` makes json-schema-capable providers return a
    // deterministic SOAP object (parsed by parseSoapJson); ollama ignores it so we
    // omit it there and fall back to the prose regex parse (P0-C).
    const includeResponseFormat = (provider ?? '').toLowerCase() !== 'ollama';
    // the bounded auto-repair retry appends the corrective
    // instruction AFTER the stable prompt so the prefix-cache-friendly lead-in
    // (Phase 4D.1) stays byte-identical between the original and repair calls.
    const payload = {
      prompt: corrective ? `${promptText}${corrective}` : promptText,
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
    const stats = this.parseGenerationStats(response.data);
    // TASK-552 Lane B — stamp WHICH AiTaskDefault routing key served this
    // flush (`smr.live`, never `smr.finalize` — this method is the live tier
    // exclusively, see the `resolveSmrSelection(tenantId, 'live')` call above).
    // SMR itself has no notion of this key; it only echoes back the
    // provider/model it actually ran, so the tier provenance is stamped here.
    return {
      text: mapSmrGenerateResponse(response.data).summary,
      stats: stats ? { ...stats, task_key: 'smr.live' } : null,
      structured: includeResponseFormat,
    };
  }

  /**
 * extract the AD-1 GenerationStats block from the SMR
   * `/generate` response for the SSE payload. Passes the normalized headline
   * fields through near-verbatim (snake_case, matching the SMR contract) minus
   * `engine_native` (the raw per-provider blob stays server-side, off the
   * browser stream). Returns `null` when the `stats` block is absent (legacy
   * response) or null (idempotency-cache hit) so the flush omits `metadata`.
   */
  private parseGenerationStats(data: unknown): LiveSummaryStatsDto | null {
    const raw = (data as { stats?: unknown } | null | undefined)?.stats;
    if (!raw || typeof raw !== 'object') return null;
    const rest = { ...(raw as Record<string, unknown>) };
    delete rest.engine_native;
    return rest as LiveSummaryStatsDto;
  }

  private async callNlp(text: string, signal?: AbortSignal): Promise<{ entities: LiveSummaryEntityDto[]; vitals?: LiveSummaryVitalsDto }> {
    // TASK-552 Lane A: inject the effective `nlp.ner` AiTaskDefault model
    // (mirrors AiInferenceController's playground mapping) so a global
    // admin's re-point governs the live plane too, not just the playground.
    // Fail-open: {} on any resolution hiccup, or when CLS isn't wired (this
    // service isn't otherwise request-scoped — see the constructor).
    const modelSelection = this.cls ? await resolveNerModelInjection(this.aiTaskDefaultService, this.cls, this.logger) : {};
    const response = await this.httpService.axiosRef.post(
      `${this.nlpServiceUrl}/api/v1/classify/tokens`,
      { text, ...modelSelection },
      { timeout: 30000, signal },
    );
    // Canonical NLP wire shape (apps/nlp schemas/common.py Entity): text / entity_type /
    // position.{start,end} / icd_code (deterministic OntologyLinker; present only for the
    // curated vocabulary, absent otherwise — carried through so the UI can chip ICD-10 codes).
    const raw = (response.data?.entities ?? []) as Array<{
      entity_type?: string;
      text?: string;
      confidence?: number;
      icd_code?: string | null;
      position?: { start?: number; end?: number };
    }>;
    const entities = raw.map((e) => ({
      text: e.text ?? '',
      type: e.entity_type ?? 'UNKNOWN',
      confidence: e.confidence,
      icd10: e.icd_code ?? undefined,
      start: e.position?.start,
      end: e.position?.end,
    }));
    return { entities, vitals: this.mapVitals(response.data?.vitals) };
  }

  /**
   * Map the NLP `Vitals` wire shape (snake_case, null-safe deterministic
   * extraction) to `LiveSummaryVitalsDto`. Returns undefined when the NLP
   * service reported no vitals — never fabricated.
   */
  private mapVitals(raw: unknown): LiveSummaryVitalsDto | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const v = raw as {
      systolic?: number | null;
      diastolic?: number | null;
      heart_rate?: number | null;
      spo2?: number | null;
      temperature_c?: number | null;
      weight_kg?: number | null;
    };
    const mapped: LiveSummaryVitalsDto = {
      ...(typeof v.systolic === 'number' ? { systolic: v.systolic } : {}),
      ...(typeof v.diastolic === 'number' ? { diastolic: v.diastolic } : {}),
      ...(typeof v.heart_rate === 'number' ? { heartRate: v.heart_rate } : {}),
      ...(typeof v.spo2 === 'number' ? { spo2: v.spo2 } : {}),
      ...(typeof v.temperature_c === 'number' ? { temperatureC: v.temperature_c } : {}),
      ...(typeof v.weight_kg === 'number' ? { weightKg: v.weight_kg } : {}),
    };
    return Object.keys(mapped).length > 0 ? mapped : undefined;
  }

  /** Merge vitals field-wise across flushes — a later non-null value wins; prior values persist. */
  private mergeVitals(prior: LiveSummaryVitalsDto | undefined, next: LiveSummaryVitalsDto | undefined): LiveSummaryVitalsDto | undefined {
    if (!prior) return next;
    if (!next) return prior;
    const merged = { ...prior, ...next };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Ground transcript-extracted entities to the rendered note.
   *
   * NER runs over the raw transcript (the source of truth), so every candidate entity is
   * transcript-supported by construction. To highlight it in the note the panel renders, each
   * entity's surface form is RE-LOCATED within `runningSummary` and its `start`/`end` set to
   * that span — so highlight offsets always index the rendered surface, never a different
   * string (the raw NER offsets index the transcript delta, not the note). An entity whose
   * surface form does not occur in the note is DROPPED: there is nothing to anchor a highlight
   * to, and — because NER never sees the note — a note-only (hallucinated) mention is never a
   * candidate here, closing the hallucination-laundering path.
   *
   * De-duplicated by (case-folded text + type); the first note occurrence wins and input order
   * is otherwise preserved (prior entities before this flush's newly-extracted ones — the merge
   * that preserves recall across flushes). Matching is case-insensitive so a sentence-cased note
   * token still grounds its transcript mention; it is purely lexical (no model) — a paraphrased
   * mention that shares no surface form with the note is intentionally not surfaced (source-
   * faithful over recall).
   */
  private groundEntitiesToNote(entities: LiveSummaryEntityDto[], note: string): LiveSummaryEntityDto[] {
    if (!note) return [];
    const haystack = note.toLowerCase();
    const seen = new Set<string>();
    const grounded: LiveSummaryEntityDto[] = [];
    for (const entity of entities) {
      const needle = entity.text ?? '';
      if (!needle.trim()) continue;
      const key = `${needle.toLowerCase()}\0${entity.type}`;
      if (seen.has(key)) continue;
      const at = haystack.indexOf(needle.toLowerCase());
      if (at < 0) continue; // no transcript-supported mention survives in the rendered note → drop
      seen.add(key);
      grounded.push({ ...entity, start: at, end: at + needle.length });
    }
    return grounded;
  }

  /**
   * Output-side groundedness gate call.
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

    // A response we distrust (`checked !== true`: any
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
  // Admin live console: per-session stats in Redis
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
   * stats. Reads the `live-doc:active:{tenantId}`
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
   * Read one session's stats. Tenant-isolated: returns `null`
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
  // Runtime kill-switch (env default + Redis override)
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

  /** Read the effective live-engine config / kill-switch. */
  async getEngineConfig(): Promise<LiveDocEngineConfigResponse> {
    await this.refreshEngineOverride();
    return {
      enabled: this.isEngineEnabled(),
      envDefault: this.enabled,
      source: this.engineEnabledOverride === null ? 'env-default' : 'redis-override',
      updatedAt: this.engineConfigUpdatedAt ?? undefined,
      updatedBy: this.engineConfigUpdatedBy ?? undefined,
      // the effective agentic.context.* knobs the loop reads.
      contextSettings: {
        'liveDelta.maxChars': this.lastAgenticContext.liveDeltaMaxChars,
        'liveFlush.segmentThreshold': this.lastAgenticContext.segmentThreshold,
        'liveFlush.idleMs': this.lastAgenticContext.idleMs,
        'transcript.mode': this.lastAgenticContext.transcriptMode,
        'tokenBudget.perRun': this.lastAgenticContext.tokenBudgetPerRun,
      },
    };
  }

  /**
   * Toggle the runtime kill-switch. Persists a Redis override
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
