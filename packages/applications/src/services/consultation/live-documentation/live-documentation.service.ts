import { createHash } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type MessageEvent,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Observable, type Subscription } from 'rxjs';
import {
  AgentSessionKind,
  AgentStepStatus,
  AgentStepType,
  ConsultationRepository,
  ContextItemEntity,
  ContextItemFactory,
  ContextItemRepository,
  ContextItemType,
  DocumentSectionRepository,
  PromptTemplateRepository,
  WorkflowDefinitionRepository,
} from '@arcaai/domains';
import { IRedisCacheService } from '../../baseServices/redis';
import { IAgentTrajectoryService } from '../../agent-trajectory/IAgentTrajectoryService';
import type { CreateAgentTrajectoryStepInput } from '../../agent-trajectory/dto';
import { SecretsService } from '../../baseServices/_meta/secrets';
import {
  TENANTLESS,
  closedFlagTerminal,
  encryptPhiFields,
  internalServiceHeaders,
  resolveInternalAccessToken,
  sseFromRedisChannel,
} from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { StreamingAudioBridgeService } from '../../stt/streaming/streamingAudioBridge.service';
import { mapTextGenerateResponse } from '../summary/text-generate';
import { HarnessPolicyService } from '../../harness-policy/harness-policy.service';
//  — the ONE reader of a node's `llmBinding`, shared with the durable
// interpreter's Python mirror (`nodes/_shared.py`'s `read_model_slug`).
import { AgentResolverService } from '../../agent/agent-resolver.service';
import { TextAgentResolverService } from '../../agent/text-agent-resolver.service';
import type { ResolvedTextCandidate, ResolvedTextGenerationSpec } from '../../agent/text-generation-spec';
// TASK-890 §3.2/§3.3 — the ONE prompt grammar and the ONE scope. The realtime and durable lanes
// render the SAME `core.agent` node, so they must render it the same way.
import {
  CORE_PALETTE_KEY,
  guardrailOptOutOf,
  PromptTemplateSyntaxError,
  PromptVariableUnresolvedError,
  renderTemplate,
  resolveGuardrailDecision,
} from '@arcaai/workflow-contract';
import { buildAgentPromptScope } from '../../agent/agent-prompt-scope';
// TASK-890 §3.13 (OD-E) — this lane posts straight to `apps/text` and recorded nothing.
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { IUsageLedgerService } from '../../usageLedger/IUsageLedgerService';
import { withUsageAttributes, withUsageTrigger } from '../../usageLedger/usage-attributes';
import { buildLlmUsageInput, parseTextUsageDetail } from '../summary/text-usage';
import { IAiRoutingPolicyService } from '../../ai-routing-policy/IAiRoutingPolicyService';
import { ConsultationPipelineEvent, type ContextAddedPayload, type ContextRemovedPayload } from '../events';
import {
  LiveDocEngineConfigResponse,
  LiveDocRealtimeCapabilitiesResponse,
  type LiveDocRealtimeAssignmentSource,
  LiveDocNodeDegradeResponse,
  LiveDocSessionStatsResponse,
  LiveDocSessionsListResponse,
  LiveSummaryEntityDto,
  LiveSummaryEventDto,
  LiveSummaryGroundednessDto,
  LiveSummaryVitalsDto,
  LiveSummaryStatsDto,
  LiveSummaryAgentDto,
} from './dto';
// the harness inbound contract for interpreter summary text. Type-only: this
// service consumes the shape, never the harness module's runtime code.
import type { HarnessLiveAssistProposalDto, HarnessLiveSummaryRequest, HarnessRealtimeDeliveryAck } from '../harness/dto/realtime-delivery.dto';
// Lane R (R1) — the live clinician-assist feed. A RUNTIME import (unlike the type-only line
// above) because the grammar pass publishes its proposals through this service rather than
// re-implementing the two-branch snapshot fold beside it.
import { HarnessLiveAssistService } from '../harness/harness-live-assist.service';
import { DEFAULT_MAX_FINDINGS, parseImportantFindings } from './realtime/parse-findings';
import { verifyCorrectionProposals } from './realtime/verify-corrections';
import { buildRunningSummary, parseDocumentJson, parseDocumentSections } from './document-shape-parser';
import { readSummaryLanguage, summaryLanguageName } from '../consultation/summary-language';
// the clinical-document SHAPE catalog. The live loop no longer knows
// what a SOAP note is: it resolves a COMPILED template once per session and
// reads its strict `responseFormat`, its section list and its prose instruction
// off that. Type-only for the artifacts, value import for the platform default
// (the fail-open tier) and the resolver port.
import type { CompiledDocumentTemplate } from '../../document-template/document-template-compiler';
import { compileDocumentTemplate } from '../../document-template/document-template-compiler';
import { SOAP_NOTE_SHAPE, SOAP_NOTE_SLUG } from '../../document-template/platform-document-shapes';
import {
  IDocumentTemplateService,
  type IDocumentTemplateService as IDocumentTemplateServicePort,
  type ResolvedDocumentTemplate,
} from '../../document-template/IDocumentTemplateService';
import {
  DEFAULT_LIVE_TOOL_PLAN,
  ILiveAgentResolver,
  type FrozenLiveAgentSnapshot,
  type ILiveAgentResolver as ILiveAgentResolverPort,
  type PersistedLiveAgentLineage,
} from './live-agent.port';
import { LiveToolRegistry } from './live-tool-registry';
// the realtime graph executor. The flush no longer runs a hardcoded
// sequence; it walks a LANE, and which lane it walks is data.
import { GUARDRAIL_GROUNDEDNESS_TOOL } from './live-tool-registry';
import {
  DocumentSectionStore,
  GuardMemo,
  reanchorAnnotations,
  PLATFORM_REALTIME_LANE,
  buildRealtimeLane,
  readAgentRef,
  realtimeCapabilityOf,
  realtimeDocumentTemplateSlug,
  realtimeNodeIsTogglable,
  runRealtimeLane,
  type RealtimeAgentRef,
  type RealtimeAgentTask,
  type RealtimeCapabilities,
  type RealtimeCapabilityKey,
  type RealtimeLane,
  type RealtimeNode,
  type RealtimeResolvedAgentView,
  type RealtimeRunResult,
  type SectionPatchDto,
} from './realtime';
import { PRE_SUMMARY_EVENT, type PreSummaryEventDto, type PreSummaryStatus } from './realtime/dto/section-patch.dto';
import { ILivePreSummaryRunner, type ILivePreSummaryRunner as ILivePreSummaryRunnerPort } from './live-pre-summary.port';
import { readGoverningEngineMarker, tenantWorkflowGoverns } from '../governing-engine';
// lane A — the consultation's OWN workflow selection, durable from create.
import { readWorkflowSelectionMarker } from '../consultation/workflow-selection';
// The palette predicate the authorization gate and the selectable-set listing both call.
// Imported rather than restated: a third copy of "may this graph govern a consultation?" is
// exactly how the three answers would come apart.
import { consultationSelectionViolation } from '../workflow-dispatch/consultation-selection-policy';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY, CONSULTATION_GATE_DEFAULTS } from '../consultation-gates.constants';
import { IWorkflowAssignmentService } from '../../workflow-assignment/IWorkflowAssignmentService';
import { generateJsonWithRepair, looksLikeJsonObject } from '../shared/bounded-json-repair';
import type { LiveSummarySectionDto } from './dto';
import {
  AGENTIC_CONTEXT_DEFAULTS,
  AGENTIC_CONTEXT_KEY_PREFIX,
  type AgenticTranscriptMode,
} from '../../settings-registry/descriptors/agentic-context.descriptors';
import {
  CONSULTATION_REALTIME_DEFAULTS,
  CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY,
} from '../../settings-registry/descriptors/consultation-realtime.descriptors';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { LIVE_DOC_GROUNDEDNESS_ENABLED_KEY } from '../../settings-registry/descriptors/feature-availability.descriptors';
import { TextRequestEnrichmentService } from '../../text-request/text-request-enrichment.service';

// F-28: defensive caps on the append-only `LiveSession.transcriptParts` buffer.
// A pathological/runaway session (mic left open past `stop()`) would otherwise
// grow it unbounded — windowing/truncation (see `bounded transcript cost`)
// only bounds what's SENT per flush, not the underlying array's growth. WARN
// once past this many finals (still fully served); refuse to append past the
// hard cap (protects process memory).
const TRANSCRIPT_PARTS_WARN_THRESHOLD = 10_000;
const TRANSCRIPT_PARTS_HARD_CAP = 50_000;

/**
 * Context kinds `handleContextAdded` was written for — human-authored notes
 * and attachments only. Mirrors `ContextService`'s `LIVE_CONTEXT_TYPES` gate
 * as it stood before the loop event plane widened `ContextAdded` emission to
 * TRANSCRIPT and STRUCTURED: this filter keeps this consumer's
 * input set unchanged by that widening, so transcripts/derived context never
 * get folded into the running summary via this path (transcripts already
 * drive the live session through `ingestSegment`, not this event).
 */
const LIVE_DOC_CONTEXT_TYPES = new Set<string>([ContextItemType.WORKNOTE, ContextItemType.CASE_NOTE, ContextItemType.ATTACHMENT]);

/**
 * the PLATFORM template, compiled once at module load.
 *
 * This is the FAIL-OPEN tier: what a session serves when no tenant template can
 * be resolved. It replaces the former `SOAP_OUTPUT_INSTRUCTION` constant, which
 * hardcoded four headings as a string literal and was therefore the reason a
 * tenant could not author a discharge summary at all. The four SOAP sections
 * still exist — as a ROW in the catalog (`SOAP_NOTE_SHAPE`), compiled by the
 * same compiler as anyone else's shape.
 */
/**
 * TASK-876 — a `core.agent` node's per-node overrides (`config.overrides`): prompt variables
 * and generation hyper-parameters within the agent's declared ranges. Malformed shapes read as
 * empty — the authoring schema is where a bad shape is refused.
 */
interface NodeOverrides {
  promptVariables: Record<string, unknown>;
  generation: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nodeOverrides(config: Readonly<Record<string, unknown>> | undefined): NodeOverrides {
  const overrides = asRecord(config?.overrides);
  return { promptVariables: asRecord(overrides.promptVariables), generation: asRecord(overrides.generation) };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * TASK-890 §3.2 — an unresolved prompt variable, raised so `callText` can tell it apart from a
 * provider outage.
 *
 * The fallback chain exists to survive an ENGINE failing. Every candidate renders the same
 * template against the same scope, so switching after a render failure would re-raise
 * identically while spending the flush's remaining budget: the node degrades on the first one,
 * with the path named.
 */
class LivePromptUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LivePromptUnresolvedError';
  }
}

/**
 * Render an agent instruction on the REALTIME lane through the ONE grammar (§3.2), over the
 * §3.3 scope.
 *
 * This lane has no `core.trigger` and no `core.variable` handler (`realtime-node-registry.ts`),
 * so it publishes no `trigger` / `vars` / `nodes` roots: what it HAS is the agent's bound
 * variables overlaid by the node's `overrides.promptVariables`. Binding those roots to empty
 * objects would claim the run has a trigger whose fields are all missing, which is a different —
 * and more misleading — finding than "this lane declares no trigger".
 */
function renderLivePrompt(content: string, variables: Record<string, unknown>, agentSlug: string): string {
  try {
    // Scope construction is INSIDE the try: a `{ path }` binding is resolved through the same
    // grammar, so an unresolvable binding raises here and must degrade the node with the path
    // named rather than escape as an unhandled error.
    const scope = buildAgentPromptScope({ variables, templateRef: `agent:${agentSlug}` });
    return renderTemplate(content, scope, { templateRef: `agent:${agentSlug}` });
  } catch (error) {
    if (error instanceof PromptVariableUnresolvedError) {
      throw new LivePromptUnresolvedError(`core.agent: prompt_variable_unresolved: ${error.path} (agent '${agentSlug}')`);
    }
    if (error instanceof PromptTemplateSyntaxError) {
      throw new LivePromptUnresolvedError(`core.agent: prompt_template_syntax: ${error.message} (agent '${agentSlug}')`);
    }
    throw error;
  }
}

const PLATFORM_TEMPLATE: ResolvedDocumentTemplate = Object.freeze({
  templateId: null,
  slug: SOAP_NOTE_SLUG,
  versionNumber: null,
  documentTemplateVersionId: null,
  compiled: compileDocumentTemplate(SOAP_NOTE_SHAPE),
});

/**
 * The stable, prefix-cache-friendly lead-in for ONE template.
 *
 * Derived rather than written out, so the prose instruction a prose-only
 * provider receives and the strict `json_schema` a structured provider is
 * decoded against are provably the same document. The hand-maintained pair they
 * replace could drift, and a drift there is silent: the model is told one thing
 * and constrained to another.
 */
function buildStableUserPrefix(compiled: CompiledDocumentTemplate): string {
  return (
    'You are assisting a clinician during a live consultation, maintaining a concise, factual ' +
    `running clinical note structured as "${compiled.title}". ` +
    compiled.promptInstruction
  );
}

/**
 * stable, prefix-cache-friendly lead-in for the live TEXT
 * user prompt. This block is BYTE-IDENTICAL on every flush of a session (first
 * flush AND every subsequent update flush), so a prefix-cache engine (vLLM /
 * llama.cpp `cache_prompt`) reuses the KV cache of the stable prefix instead of
 * re-prefilling a mode-specific directive. `buildTextUserPrompt` emits the blocks
 * in the order `[stable system] + [transcript-so-far] + [current note] +
 * [delta instruction]`, keeping the variable, mode-specific directive LAST.
 */
export const LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX = buildStableUserPrefix(PLATFORM_TEMPLATE.compiled);

/**
 * The TEXT `system_prompt` for the live running-note call.
 *
 * LIFTED VERBATIM out of the inline `callText` literal — the bytes
 * are unchanged (the paired sha256 guards in `live-soap-prompt-checksum.test.ts`
 * and `system-live-soap-default-checksum.test.ts` pin them, and C2's seed
 * carries the identical string under `metaData.promptConfig.systemPrompt`).
 * Exported because it is now tier 3 of the live chain: the fail-open source a
 * session freezes when no governed template can be resolved.
 */
export const LIVE_DOCUMENT_SYSTEM_PROMPT =
  'You are a clinical documentation assistant generating an in-progress, structured clinical running note. ' +
  'Be concise and faithful to the transcript; never fabricate findings.';

/**
 * Safety cap on the transcript delta sent per flush (sliding-window fallback):
 * the incremental prompt only sends new transcript since the last successful
 * flush, but if TEXT keeps failing the un-flushed delta grows — this bounds it
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
 * One TEXT `/generate` call result for the bounded JSON auto-repair coordinator
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

/**
 * what a GRAPH-MODE flush produces, projected onto exactly the locals
 * the legacy path produces. Everything downstream is shared, so this projection
 * is the seam the trajectory-parity diff measures across.
 */
interface GraphFlushProjection {
  sections: LiveSummarySectionDto[];
  runningSummary: string;
  textFailed: boolean;
  textLatencyMs: number;
  textStats: LiveSummaryStatsDto | null;
  textRepaired: boolean;
  repairLatencyMs: number;
  repairStats: LiveSummaryStatsDto | null;
  entities: LiveSummaryEntityDto[];
  /** Lane N — the tenant instruction's IMPORTANT FINDINGS for this flush. Empty when the lane
   *  runs no `agent.important_findings` node, which is every lane authored before Lane N. */
  findings: LiveSummaryEntityDto[];
  vitals?: LiveSummaryVitalsDto;
  nlpRan: boolean;
  nlpFailed: boolean;
  nlpLatencyMs: number;
  /** The raw run, for the trajectory and for the parity diff. */
  run: RealtimeRunResult;
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
  /**
   * TASK-891 B3 — true while a generation is running. The single-flight gate: a
   * non-forced flush requested while this is set coalesces instead of starting a
   * competing generation.
   */
  inFlight?: boolean;
  /** TASK-891 B3 — a flush was requested mid-generation; run one trailing re-run on completion. */
  coalescedFlush?: boolean;
  /** Aborts the in-flight TEXT/NLP HTTP calls when a newer flush supersedes them. */
  abortController?: AbortController;
  /** How many `transcriptParts` have already been folded into `lastPayload` (incremental prompt cursor, P0-B). */
  flushedTranscriptCount: number;
  /** Epoch ms of the last TEXT-producing flush — drives the min-interval throttle (P0-A). */
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
   * Stable, per-instance trajectory session id used as the
   * `sessionId` on every emitted step. Distinct across stop→restart of the same
   * consultation so the `(tenantId, sessionId, runId, seq)` composite-unique key
   * never collides (which would make `skipDuplicates` silently drop the restarted
   * session's steps). Set once at creation and NEVER reassigned when a later STT
   * stream attaches, so grouping stays stable for the session's whole lifetime.
   */
  trajectorySessionId: string;
  /** Monotonic trajectory-step sequence within this LIVE_DOC session. */
  trajectorySeq: number;
  /**
   * The session's FROZEN agent identity.
   *
   * `agentPromise` is kicked off (memoized) at `start()`; `agentSnapshot` caches
   * its value on first use. Every flush reads the CACHED snapshot, so the loop
   * adds ZERO blocking I/O per flush, and a mid-session template edit/approval
   * can never mutate a running consultation.
   */
  agentPromise?: Promise<FrozenLiveAgentSnapshot>;
  agentSnapshot?: FrozenLiveAgentSnapshot;
  /**
   * The session's FROZEN document template.
   *
   * Resolved once at `start()` and cached exactly like `agentSnapshot`, and for
   * the same reason: a tenant publishing a new template version mid-consultation
   * must not change the shape of the note already being produced. The pinned
   * `documentTemplateVersionId` travels with it so anything generated can be
   * stamped with the version it was constrained by.
   */
  templatePromise?: Promise<ResolvedDocumentTemplate>;
  templateSnapshot?: ResolvedDocumentTemplate;
  /**
   * task 13 — the SUBSTRATE GATE.
   *
   * `startRecording` used to call `start()` after only an ownership and status
   * check, so the hardcoded loop ran for every recording session regardless of
   * what the tenant had authored (the root cause). Resolved once
   * at `start()` with the same discipline as the agent and the template above;
   * `false` means this engine must stand down entirely.
   *
   * `false` no longer follows from the governing marker alone. See
   * {@link LiveDocumentationService.ensureSubstrateResolved} for the three-way contract.
   */
  substratePromise?: Promise<boolean>;
  substrateAllowed?: boolean;
  /**
   * does a TENANT-AUTHORED workflow govern this consultation?
   *
   * Frozen beside `substrateAllowed`, and deliberately NOT the same question. A governed
   * session in GRAPH mode keeps running (`substrateAllowed === true`) because it walks the
   * governing definition's realtime lane, which the durable interpreter skips. What it must
   * never do is fall back to the LEGACY flush, which would write a second, hardcoded document
   * beside the one the durable run owns — so `flush()` reads this flag to refuse that
   * fall-through.
   */
  governedByTenantWorkflow?: boolean;
  /**
   * the session's FROZEN realtime lane, and whether the graph
   * executor is enabled for this tenant. Frozen for the same reason the agent and
   * template are: a publish mid-consultation must not change the engine walking
   * the note already being produced.
   */
  lanePromise?: Promise<RealtimeLane | null>;
  laneSnapshot?: RealtimeLane | null;
  /**
   * The transcript the CAPTURE node publishes for the flush currently in flight.
   *
   * Set immediately before the lane runs. It exists because the capture node is a
   * real producer of `transcript` (task 14) rather than a declaration nothing
   * keeps — the value it publishes is the live ASR stream this session ingested,
   * and downstream nodes reach it only through the declared port.
   */
  pendingGraphTranscript?: string;
  /**
   * The `AsrPipeline` this session's capture is bound to, when known.
   *
   * `ConsultationWorkflowDispatchService` already resolves it
   * (`sttPipelineId` on its result) from the tenant's `stt`-palette assignment;
   * threading it into `POST :id/recording/start` is a request-DTO change this
   * ticket does not make, so today it is undefined and the capture node reports
   * `pipelineId: null`. That is observability, not behaviour: the transcript the
   * node publishes is the pipeline's output either way.
   */
  sttPipelineId?: string | null;
  /**
   * TASK-932 §3.7 — the consultation's declared SUMMARY language, frozen at `start()`.
   *
   * `null` = undeclared, which is not English: the operating frame then says nothing about an
   * output language and the department body decides, exactly as it did before this ticket. Frozen
   * with the agent, the template and the lane for the same reason all three are — the note being
   * produced must not change language halfway through because a row was edited.
   */
  summaryLanguage?: string | null;
  /**
   * TASK-932 D-9 — the WARM START, kicked off at `start()` and never awaited by a flush.
   *
   * Held on the session only so a `stop()` racing it can be reasoned about and a test can await
   * it: nothing downstream depends on its value. The pre-summary it produces is read from the
   * database (`resolveWarmStartPreSummary`) and from the live feed, not from here.
   */
  onStartPromise?: Promise<void>;
}

/**
 * LiveDocumentationService — net-new realtime watcher (Clinical Workflow Playground).
 *
 * Per-consultation, transient (Redis only — no Prisma models). Consumes live
 * STT final segments (from `stt:result:{sessionId}`) plus context-add events,
 * debounces (~3 final segments OR ~5s idle), calls the existing TEXT client for
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

/**
 * An explicitly-pinned boolean env override, or undefined when the deployment
 * does not set one. Distinguishing "unset" from "set to false" is what lets a
 * fixture that pinned a flag keep meaning what it said once the real answer
 * moved to the settings cascade.
 */
function readBooleanEnv(configService: ConfigService, key: string): boolean | undefined {
  const raw = configService.get(key);
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  return String(raw) === 'true';
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

/**
 * TASK-891 B5 — the PHI-safe reason a flush produced no note, or `undefined` when nothing
 * degraded.
 *
 * The SUMMARY node's reason wins over any other node's: it is the one that decides whether
 * there is a document at all, and reporting an entity-extraction failure as the reason the
 * case note is blank would send a reader after the wrong service. (In the traced session
 * both degraded at once — TEXT on a 20 s timeout, NLP on `ECONNREFUSED` — and only the
 * first explains the empty note.)
 *
 * `RealtimeDegradeEvent.reason` is contractually a reason code or an error name, never
 * clinical text, which is what makes it safe to put on the clinician's feed.
 *
 * TASK-893 — WHICH node is the summary one is answered by its CAPABILITY, never by a type
 * string: every realtime node is a `core.agent` now, so matching on the type would pick the
 * transcription node's reason as often as the summary node's.
 */
function realtimeDegradeReason(run: RealtimeRunResult, lane: RealtimeLane): string | undefined {
  if (run.events.length === 0) return undefined;
  const capabilities = realtimeCapabilityIndex(lane);
  const event = run.events.find((e) => capabilities.get(e.nodeId) === 'generateDocument') ?? run.events[0];
  return `${event.status}: ${event.reason}`;
}

/**
 * Node id → the capability that node is expected to run, derived from the lane's authored config.
 *
 * The outcome's OWN `capability` is what actually ran and wins wherever it is present — but it is
 * present only on `succeeded`, and every consumer below has to attribute the failures too.
 */
function realtimeCapabilityIndex(lane: RealtimeLane): Map<string, RealtimeCapabilityKey | undefined> {
  const index = new Map<string, RealtimeCapabilityKey | undefined>();
  for (const stage of lane.stages) {
    for (const node of stage.nodes) index.set(node.nodeId, realtimeCapabilityOf(node.type, node.config));
  }
  return index;
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
  private readonly textServiceUrl: string;
  private readonly guardrailServiceUrl: string;
  private readonly heartbeatMs: number;
  // `agentic.context.*` env FALLBACKS. These are no longer the
  // effective values: the authority is the settings registry, resolved per call
  // through `resolveAgenticContext`'s `EffectiveSettingsService`.
  //
  // These six used to be read from `env ?? AGENTIC_CONTEXT_DEFAULTS` in the
  // constructor and frozen there — so a super admin's registry write moved what
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
  private readonly textMaxTokens: number;
  /**
   * TASK-891 B1 — the ENV OVERRIDE for the realtime TEXT budget, or `undefined` when
   * unset. Captured here, never used as the effective value: the authority is the
   * `consultation.realtime.textTimeoutMs` descriptor, resolved per flush.
   */
  private readonly envTextTimeoutMs?: number;
  /**
   * TASK-891 B1 — the EFFECTIVE realtime TEXT budget for the flush in progress
   * (stored value → env override → descriptor code default), refreshed by
   * {@link resolveTextTimeoutMs} on every flush. Seeded from env/default so the
   * value before the first flush is the same one the flush would resolve.
   */
  private textTimeoutMs: number;
  private readonly textProvider?: string;
  private readonly textModel?: string;
  private readonly statsTtl: number;
  /**
   * TASK-932 D-4 - the env OVERRIDE for the groundedness gate, or undefined when
   * the deployment does not pin it. It is no longer the answer: the stored
   * `liveDoc.groundedness.enabled` row wins, resolved per flush against the
   * session tenant. Kept as the fallback for an unwired settings graph, the same
   * shape `envTextTimeoutMs` uses one field above.
   */
  private readonly envGroundednessEnabled?: boolean;
  /**
   * The EFFECTIVE groundedness gate for the flush in progress. Was `readonly`
   * and read ONCE in the constructor, which is what made turning the gate on a
   * RESTART - and made a per-tenant rollout impossible. Refreshed by
   * {@link resolveGroundednessEnabled} on every flush.
   */
  private groundednessEnabled: boolean;
  /**
   * The registry's `envDefaults` object, held by IDENTITY so a per-flush refresh
   * of `groundedness` is visible to `LiveToolRegistry.isEnabled` without giving
   * the registry a second way to be told the same fact. `ner`/`vitals` are
   * unconditional and stay literal.
   */
  private readonly toolEnvDefaults: { ner: boolean; vitals: boolean; groundedness: boolean };
  private readonly groundednessTimeoutMs: number;
  private readonly groundednessMaxRetries: number;
  private readonly groundednessRetryBackoffMs: number;
  /**
   * The config-driven tool layer. Owns the two executors the flush
   * dispatches (`nlp.classify-tokens`, `guardrail.groundedness`) and answers
   * "does the session's frozen plan enable this key?". Executors are constructed
   * lazily inside it, so a plan that disables a tool never builds one.
   */
  private readonly toolRegistry: LiveToolRegistry;
  /**
   *  — per-section writes with per-section OCC. Constructed lazily
   * on first use because its repository dependency is optional.
   */
  private sectionStore?: DocumentSectionStore;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @Inject(IRedisCacheService) private readonly cacheService: IRedisCacheService,
    private readonly redisSubscriber: RedisSubscriberService,
    @Optional() private readonly audioBridge?: StreamingAudioBridgeService,
    @Optional() @Inject(ContextItemRepository) private readonly contextItemRepository?: ContextItemRepository,
    // Resolver for the tenant's effective TEXT {provider, model}.
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // X-Service-Token for the guardrail groundedness hop
    // (SecretsService is provided by the @Global SecretsModule). Optional so unit
    // fixtures and non-DI construction paths compile; when unset an empty token is
    // sent (the guardrail's empty-token dev bypass).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Ordered per-flush trajectory emitter. Optional + trailing so
    // existing positional test fixtures and non-DI paths compile; production DI
    // (apps/api consultation module) supplies it. A trajectory failure is
    // fire-and-forget and can NEVER break the live flush (see recordFlushTrajectory).
    @Optional() @Inject(IAgentTrajectoryService) private readonly trajectoryService?: IAgentTrajectoryService,
    // Governed read facade for `agentic.context.*`.
    // Optional + trailing so existing positional fixtures keep their arity; absent
    // ⇒ env/code-default resolution.
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
    // Resolves the SYSTEM `nlp.ner` routing election for injection into the
    // live-plane NLP call (`resolveNerModelInjection`). Optional + trailing so
    // existing positional fixtures keep their arity; absent ⇒ the NER hop is
    // refused with a 503 naming the key (fail-closed).
    @Optional() @Inject(IAiRoutingPolicyService) private readonly routingPolicies?: IAiRoutingPolicyService,
    // CLS accessor for the SYSTEM-pin the resolver needs (this service is not
    // otherwise request-scoped). `ClsService` is provided by the globally-
    // registered `ClsModule` (see the class doc above). Optional + trailing so
    // existing positional fixtures keep their arity; absent ⇒ the resolver call
    // is skipped defensively — see `NlpExtractionTool` in `live-tool-registry.ts`.
    @Optional() private readonly cls?: ClsService<IActiveUserContext>,
    // The NARROW port that resolves the session's governed agent
    // ONCE at start(). Deliberately NOT PromptAssemblyService (C1 DR-3): the
    // live prompt is a bespoke prefix-cache-ordered concatenation, not the
    // template-assembly pipeline. Optional + trailing so existing positional
    // fixtures keep their arity; ABSENT ⇒ the service synthesizes the
    // code-default snapshot locally from the in-code constants, i.e. behavior
    // byte-identical to pre-C3.
    @Optional() @Inject(ILiveAgentResolver) private readonly liveAgentResolver?: ILiveAgentResolverPort,
    // the SHARED TEXT enrichment path. TEXT holds no endpoint or
    // credential of its own since lane B (`70eec34d5`) deleted its
    // per-provider env plane, so an outgoing `/api/v1/generate` body without a
    // `provider_overrides` entry fails closed with 503
    // PROVIDER_CREDENTIALS_MISSING — which is exactly what this, the
    // highest-volume TEXT hop in the platform, was doing on every flush.
    // Optional + trailing so existing positional fixtures keep their arity.
    @Optional() @Inject(TextRequestEnrichmentService) private readonly textRequestEnrichment?: TextRequestEnrichmentService,
    // the clinical-document SHAPE catalog. Optional + trailing so
    // existing positional fixtures keep their arity; ABSENT ⇒ every session
    // serves the compiled PLATFORM shape, i.e. behavior equivalent to the
    // hardcoded four-section format this ticket replaced.
    @Optional() @Inject(IDocumentTemplateService) private readonly documentTemplateService?: IDocumentTemplateServicePort,
    // the SUBSTRATE GATE's read half. Carries the durable
    // governing-engine marker `ConsultationWorkflowDispatchService` writes; the
    // same row `LoopContextSignalService.standDownForTenantWorkflow` reads before
    // every loop signal. Optional + trailing so existing positional fixtures keep
    // their arity; ABSENT ⇒ the gate cannot resolve and FAILS OPEN to this engine,
    // because a consultation documented by the default engine is a better
    // clinical outcome than one documented by nobody.
    @Optional() @Inject(ConsultationRepository) private readonly consultationRepository?: ConsultationRepository,
    // the realtime LANE's two resolution hops: which definition the
    // tenant assigned, and that definition's compiled config. Both optional and
    // trailing; ABSENT ⇒ every session serves PLATFORM_REALTIME_LANE, which
    // encodes today's behaviour.
    @Optional() @Inject(IWorkflowAssignmentService) private readonly workflowAssignments?: IWorkflowAssignmentService,
    @Optional() @Inject(WorkflowDefinitionRepository) private readonly workflowDefinitionRepository?: WorkflowDefinitionRepository,
    //  — per-section persistence. Optional + trailing; ABSENT ⇒
    // section writes report `unavailable` and the whole-document payload still
    // publishes, so the clinician never loses the feed to a persistence outage.
    @Optional() @Inject(DocumentSectionRepository) private readonly documentSectionRepository?: DocumentSectionRepository,
    // Lane R (R1) — the two halves the live GRAMMAR pass needs, both optional and trailing so
    // existing positional fixtures keep their arity.
    //
    // `promptTemplateRepository` resolves the correction prompt from the NODE's own
    // `promptTemplateId` binding. The prompt is CONFIG (`00-project-context.md` §Configuration
    // Principles), so there is deliberately NO in-code default to fall back to: an unbound or
    // unapproved template DEGRADES the node with a named reason rather than substituting a
    // literal nobody governs.
    @Optional() @Inject(PromptTemplateRepository) private readonly promptTemplateRepository?: PromptTemplateRepository,
    // `liveAssist` publishes the proposals onto the EXISTING clinician-assist plane — the same
    // `consultation:live-assist:{id}` channel the durable engine publishes to, folded by the same
    // service. A second transport for one payload is how two feeds come apart.
    @Optional() @Inject(HarnessLiveAssistService) private readonly liveAssist?: HarnessLiveAssistService,
    // TASK-876 — resolves a `core.agent` node's `agentRef` (explicit slug + version pin, fail
    // closed on drift) into the agent's model / instruction / parameters / fallback chain.
    // Optional + trailing so every positional fixture keeps its arity; absent ⇒ a `core.agent`
    // on the realtime lane degrades with a named reason (never the tenant default).
    @Optional() @Inject(TextAgentResolverService) private readonly textAgents?: TextAgentResolverService,
    // TASK-890 §3.13 (OD-E) — the realtime lane was the second unmetered production LLM path:
    // it posts to `apps/text` directly, so nothing upstream could count it and no plan ceiling
    // could bound it. Both are @Optional + trailing, so every positional fixture keeps its
    // arity and a composition without them behaves exactly as before — metering is additive and
    // must never become a precondition for documenting a consultation.
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedger?: IUsageLedgerService,
    // TASK-930 (G-1) — resolves a slug-form `core.agent` reference to the agent's TASK, which is
    // what decides WHICH capability the node runs (`SPEECH_TO_TEXT` → transcribe,
    // `NAMED_ENTITY_RECOGNITION` → extractEntities, `TEXT_GENERATION` → generateDocument). The
    // task-agnostic resolver, not `TextAgentResolverService`: the whole point is that the task is
    // not known before the agent is resolved. Optional + trailing so every positional fixture
    // keeps its arity; ABSENT ⇒ `CoreAgentHandler` falls back to TEXT_GENERATION exactly as it did
    // before this ticket, which is why the read-out reports that same fallback.
    @Optional() @Inject(AgentResolverService) private readonly agentResolver?: AgentResolverService,
    // TASK-932 D-9 — how a WARM-START (`onStart`) node actually generates. The GRAPH decides that
    // the warm start happens and which agent it names; this runs it, over the pre-summary
    // pipeline that already exists (`live-pre-summary.port.ts` documents the seam it does not
    // close). Optional + trailing so every positional fixture keeps its arity; ABSENT ⇒ a graph
    // that declares a warm start publishes `degraded: warm_start_unwired` rather than silently
    // doing nothing, because a panel that never resolves is the skeleton-forever defect again.
    @Optional() @Inject(ILivePreSummaryRunner) private readonly preSummaryRunner?: ILivePreSummaryRunnerPort,
  ) {
    this.nlpServiceUrl = this.configService.get<string>('NLP_URL') ?? 'http://localhost:8864';
    this.textServiceUrl = this.configService.get<string>('TEXT_URL') ?? 'http://localhost:8862';
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
    // Min seconds between TEXT calls for one session — protects the small local LM pool (P0-A).
    this.minIntervalMs = Number(this.configService.get('LIVE_DOC_MIN_INTERVAL_MS') ?? 4000);
    // Durable-snapshot throttle: 0 disables periodic durable writes (P1-C).
    this.durableSnapshotMs = Number(this.configService.get('LIVE_DOC_DURABLE_SNAPSHOT_MS') ?? 30000);
    // Bounded live-generation params (P0-B).
    this.textMaxTokens = Number(this.configService.get('LIVE_DOC_TEXT_MAX_TOKENS') ?? 8192);
    // TASK-891 B1 — the env value is an OVERRIDE, not the answer, and it loses to a
    // stored registry value. The old hard-coded `?? 20000` fallback sat below the
    // measured p50 of the generation it bounded, so every realtime flush timed out.
    this.envTextTimeoutMs = readNumericEnv(this.configService, 'LIVE_DOC_TEXT_TIMEOUT_MS');
    this.textTimeoutMs = this.envTextTimeoutMs ?? CONSULTATION_REALTIME_DEFAULTS[CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY];
    this.textProvider = this.configService.get<string>('LIVE_DOC_TEXT_PROVIDER') || undefined;
    this.textModel = this.configService.get<string>('LIVE_DOC_TEXT_MODEL') || undefined;
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
    // TASK-932 D-4 - the env value is an OVERRIDE for an unwired settings graph,
    // not the answer: `resolveGroundednessEnabled` re-resolves the stored
    // `liveDoc.groundedness.enabled` row against the session tenant on every
    // flush. Seeded here so the value before the first flush is the one that
    // flush would resolve.
    this.envGroundednessEnabled = readBooleanEnv(this.configService, 'LIVE_DOC_GROUNDEDNESS_ENABLED');
    this.groundednessEnabled = this.envGroundednessEnabled ?? false;
    this.groundednessTimeoutMs = Number(this.configService.get('LIVE_DOC_GROUNDEDNESS_TIMEOUT_MS') ?? 5000);
    this.groundednessMaxRetries = Number(this.configService.get('LIVE_DOC_GROUNDEDNESS_MAX_RETRIES') ?? 1);
    this.groundednessRetryBackoffMs = Number(this.configService.get('LIVE_DOC_GROUNDEDNESS_RETRY_BACKOFF_MS') ?? 200);

    // `envDefaults` is the PRE-C4 answer for every tool: NER and
    // vitals always ran; groundedness ran iff `LIVE_DOC_GROUNDEDNESS_ENABLED`.
    // A plan entry of `enabled: null` ("follow the platform default", distinct
    // from `false`) resolves to exactly these — which is why an unconfigured
    // `toolConfig` reproduces today's behavior byte for byte.
    // Held by identity - see the field's doc.
    this.toolEnvDefaults = { ner: true, vitals: true, groundedness: this.groundednessEnabled };
    this.toolRegistry = new LiveToolRegistry({
      nlp: {
        httpService: this.httpService,
        nlpServiceUrl: this.nlpServiceUrl,
        logger: this.logger,
        cls: this.cls,
        routingPolicies: this.routingPolicies,
        secretsService: this.secretsService,
      },
      groundedness: {
        httpService: this.httpService,
        guardrailServiceUrl: this.guardrailServiceUrl,
        logger: this.logger,
        secretsService: this.secretsService,
        timeoutMs: this.groundednessTimeoutMs,
        maxRetries: this.groundednessMaxRetries,
        retryBackoffMs: this.groundednessRetryBackoffMs,
      },
      envDefaults: this.toolEnvDefaults,
    });
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

    // A GENUINELY NEW session (the re-bind above has already returned) restarts
    // `generation` at 0, so the per-section staleness watermark left behind by
    // the PREVIOUS session must go with it. The store is memoized for the life
    // of this process, so without this every flush of a consultation's second
    // session is refused as `stale-generation`: no row written, no
    // `section.patch` published, and the clinician watches an empty live note.
    // Observed on a live stack; pinned by `live-documentation.session-generation.test.ts`.
    //
    // Reset on START rather than on stop() deliberately — a session that crashed,
    // lost its owner lock, or was stood down by the substrate gate never reaches
    // stop(), and those are exactly the ones whose watermark would poison the next.
    this.sections().forget(params.consultationId);

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

    // Resolve and FREEZE the session's governing agent once,
    // here. Kicked off fire-and-forget (same shape as `claimOwnership`) so
    // `start()` stays synchronous for the recording controller; `flush()` awaits
    // the memoized promise, which is already settled by the second flush.
    session.agentPromise = this.ensureAgentResolved(session);
    // task 13 — the lane the flush will walk, and the SUBSTRATE GATE.
    // Same fire-and-forget shape as the two above so `start()` stays synchronous
    // for the recording controller; `flush()` awaits the memoized promises, and
    // the gate additionally tears this session down when it resolves to "stand
    // down", so a governed consultation leaves no timers or locks behind.
    //
    // the ORDER is now load-bearing. The gate's answer depends on the MODE, and
    // the mode IS the frozen lane (`null` ⇒ legacy flush, a lane ⇒ graph executor), so the lane
    // promise must exist before the gate can await it. Kicking both off here rather than
    // chaining them keeps the lane resolving concurrently with the gate's own consultation read.
    session.lanePromise = this.ensureLaneResolved(session);
    // Same fire-and-forget shape, same reason: freeze the document
    // shape at session start so a mid-consultation publish cannot change the
    // note being produced. `flush()` awaits the memoized promise.
    //
    // TASK-891 D7 — AFTER the lane, and that order is load-bearing: the note's shape is
    // named by the governing workflow's realtime summary node, so the template cannot be
    // resolved until the lane it is named on exists.
    session.templatePromise = this.ensureTemplateResolved(session);
    session.substratePromise = this.ensureSubstrateResolved(session);
    // TASK-932 D-9 — the WARM START, kicked off with the same fire-and-forget shape as everything
    // above it and for the same reason: `start()` is synchronous for the recording controller.
    //
    // It runs IN PARALLEL with the capture session opening, which is the whole point of the
    // `onStart` cadence and of the graph edge that authors it (`n_trigger.next -> n_presummary`
    // sits beside `n_trigger.next -> n_asr`, not before it). Sequencing the pre-summary ahead of
    // capture would make the microphone wait on an LLM call over the patient's whole prior record.
    session.onStartPromise = this.runOnStartNodes(session);

    this.logger.log({ message: 'Live documentation session started', consultationId: params.consultationId, sessionId: params.sessionId });
  }

  // ------------------------------------------------------------------
  // TASK-932 D-9 — the WARM START (`onStart` cadence)
  // ------------------------------------------------------------------

  /**
   * Run the session's `onStart` nodes ONCE, and publish what happened.
   *
   * ## What makes this a graph step rather than a call the console makes
   *
   * Everything that DECIDES is on the graph: whether a warm start happens at all
   * (`lane.onStart` is empty for every lane that authors none), which agent it is
   * (`agentRef.slug`), that it runs on the realtime lane at the `onStart` cadence, and that it
   * DEGRADES rather than fails (`onError`). The durable interpreter skips the same node with
   * `reason: 'realtime_lane'` whenever a live session owns the run, so exactly one runtime
   * executes it — the invariant TASK-864/TASK-930 made structural, extended to a new cadence
   * rather than worked around.
   *
   * ## NEVER THROWS, NEVER BLOCKS
   *
   * This is background work for a consultation that is already recording. Every failure is a
   * `degraded` event with a PHI-safe reason; nothing here can fail a session, stop a flush, or
   * delay the microphone. `enabled: false` on the node is honoured exactly as the flush lane
   * honours it — an authored-but-switched-off warm start publishes nothing at all, because the
   * tenant turned it off rather than it having gone wrong.
   */
  private async runOnStartNodes(session: LiveSession): Promise<void> {
    let nodes: readonly RealtimeNode[] = [];
    try {
      const lane = session.laneSnapshot !== undefined ? session.laneSnapshot : await (session.lanePromise ?? this.ensureLaneResolved(session));
      nodes = (lane?.onStart ?? []).filter((node) => node.enabled);
    } catch {
      // A lane that cannot be resolved has already been logged by `ensureLaneResolved`, which
      // never rejects; this catch exists only so a future change there cannot take the session
      // down through this path.
      return;
    }
    if (nodes.length === 0) return;

    // The substrate gate can stand this engine down entirely (a governed consultation whose
    // durable run owns the document). Asked BEFORE anything is published: a warm start written
    // beside a document this engine does not own is the same exclusivity hazard as a flush.
    const allowed = session.substrateAllowed ?? (await (session.substratePromise ?? this.ensureSubstrateResolved(session)));
    if (!allowed) return;

    for (const node of nodes) {
      const agentSlug = readAgentRef(node.config)?.slug ?? null;
      await this.publishPreSummary(session, { status: 'running', agentSlug });

      if (!this.preSummaryRunner) {
        this.logger.warn({
          message: 'A warm-start node is authored but no pre-summary runner is wired — publishing a named degrade rather than nothing',
          consultationId: session.consultationId,
          nodeId: node.nodeId,
          agentSlug,
        });
        await this.publishPreSummary(session, { status: 'degraded', error: 'warm_start_unwired', agentSlug });
        continue;
      }

      // `run` is contractually total, so there is no try/catch here by design: a rejection would
      // be a broken implementation of the port, and swallowing it here would hide that.
      const result = await this.preSummaryRunner.run({
        consultationId: session.consultationId,
        tenantId: session.tenantId,
        userId: session.userId ?? null,
        agentSlug,
      });

      await this.publishPreSummary(session, {
        status: result.status,
        agentSlug,
        ...(result.content === undefined ? {} : { content: result.content }),
        ...(result.reason === undefined ? {} : { error: result.reason }),
      });

      this.logger.log({
        message: result.status === 'ready' ? 'Warm-start pre-summary ready' : 'Warm-start pre-summary degraded',
        consultationId: session.consultationId,
        nodeId: node.nodeId,
        agentSlug,
        // PHI-safe: a reason CODE and a LENGTH, never the text.
        reason: result.reason ?? null,
        contentChars: result.content?.length ?? 0,
      });
    }
  }

  /**
   * Publish one `presummary` event on the consultation's live channel.
   *
   * `safeChannelPublish`, not `safePublish`: this is an ADDITIVE event beside the whole-document
   * payload, exactly like `section.patch`, and it must not overwrite the snapshot cache — a
   * client reconnecting mid-consultation asks that cache for the running NOTE, and answering
   * with a pre-summary would replace the clinician's document with its own background material.
   */
  private async publishPreSummary(
    session: LiveSession,
    fields: { status: PreSummaryStatus; content?: string; error?: string; agentSlug?: string | null },
  ): Promise<void> {
    const event: PreSummaryEventDto = {
      event: PRE_SUMMARY_EVENT,
      consultationId: session.consultationId,
      status: fields.status,
      ...(fields.content === undefined ? {} : { content: fields.content }),
      ...(fields.error === undefined ? {} : { error: fields.error }),
      ...(fields.agentSlug ? { agentSlug: fields.agentSlug } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.safeChannelPublish(this.channel(session.consultationId), JSON.stringify(event));
  }

  isActive(consultationId: string): boolean {
    return this.sessions.has(consultationId);
  }

  // ------------------------------------------------------------------
  // Frozen agent identity
  // ------------------------------------------------------------------

  /**
   * The in-code fail-open snapshot (tier 3 of the live chain). Its
   * bytes are PROVEN identical to the seeded SYSTEM live default by the paired
   * sha256 guards, which is the only reason a fail-open tier is acceptable on a
   * clinical surface: it degrades to identical behavior, not different behavior.
   */
  private codeDefaultAgentSnapshot(): FrozenLiveAgentSnapshot {
    return {
      resolvedFrom: 'code-default',
      agentId: null,
      agentName: null,
      promptTemplateId: null,
      promptVersionNumber: null,
      stableUserPrefix: LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX,
      systemPrompt: LIVE_DOCUMENT_SYSTEM_PROMPT,
      toolPlan: DEFAULT_LIVE_TOOL_PLAN,
      frozenAt: new Date().toISOString(),
    };
  }

  /**
   * Resolve-and-freeze the session's agent, with THREE recovery tiers so a
   * cross-instance restart or a crash re-pins the IDENTICAL agent:
   *
   *   1. **Redis adopt** — a snapshot mirrored by the previous owner is adopted
   *      VERBATIM. This is what makes a re-attach on another instance serve the
   *      same bytes rather than silently re-resolving to newer content.
   *   2. **Durable lineage re-pin** — Redis cold but a `LIVE_SOAP_SNAPSHOT` row
   *      exists: re-fetch the pinned, IMMUTABLE `(templateId, versionNumber)`
   *      `PromptVersion` — never "latest" — so the rebuild is byte-identical.
   *   3. **Fresh resolve** — only for a genuinely new session.
   *
   * NEVER REJECTS. Any failure at any tier yields the code-default snapshot, so
   * `flush()` can `await` this without a live consultation ever being able to
   * fail on prompt resolution.
   */
  private async ensureAgentResolved(session: LiveSession): Promise<FrozenLiveAgentSnapshot> {
    // No port wired (legacy fixtures / non-DI construction): synthesize locally
    // and touch nothing — behavior byte-identical to pre-C3, zero I/O.
    if (!this.liveAgentResolver) {
      const snapshot = this.codeDefaultAgentSnapshot();
      session.agentSnapshot = snapshot;
      return snapshot;
    }

    try {
      // (1) adopt a mirrored snapshot
      const stored = await this.readStoredAgentSnapshot(session.consultationId);
      if (stored) {
        session.agentSnapshot = stored;
        this.logger.log({
          message: 'Adopted frozen live-agent snapshot from Redis (cross-instance / restart)',
          consultationId: session.consultationId,
          resolvedFrom: stored.resolvedFrom,
          promptTemplateId: stored.promptTemplateId,
          promptVersionNumber: stored.promptVersionNumber,
        });
        return stored;
      }

      // (2) re-pin from the durable snapshot's lineage block
      const lineage = await this.readDurableAgentLineage(session.consultationId);
      if (lineage) {
        const rehydrated = await this.liveAgentResolver.rehydrateFromLineage({ tenantId: session.tenantId, lineage });
        if (rehydrated) {
          session.agentSnapshot = rehydrated;
          await this.storeAgentSnapshot(session.consultationId, rehydrated);
          this.logger.log({
            message: 'Re-pinned frozen live-agent snapshot from the durable LIVE_SOAP_SNAPSHOT lineage',
            consultationId: session.consultationId,
            promptTemplateId: rehydrated.promptTemplateId,
            promptVersionNumber: rehydrated.promptVersionNumber,
          });
          return rehydrated;
        }
      }

      // (3) fresh resolve
      const resolved = await this.liveAgentResolver.resolveForSession({
        consultationId: session.consultationId,
        tenantId: session.tenantId,
      });
      session.agentSnapshot = resolved;
      await this.storeAgentSnapshot(session.consultationId, resolved);
      return resolved;
    } catch (error) {
      // The port's own contract is never-throws; this is the belt-and-braces
      // half (a Redis outage, a malformed stored snapshot, a broken port impl).
      this.logger.error({
        message: 'Live-agent resolution failed — falling open to the in-code prompt constants',
        consultationId: session.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      const snapshot = this.codeDefaultAgentSnapshot();
      session.agentSnapshot = snapshot;
      return snapshot;
    }
  }

  /**
   * Resolve and FREEZE the session's document template.
   *
   * Deliberately simpler than `ensureAgentResolved`: there is no Redis mirror
   * and no durable lineage re-pin, because a template is not an identity that a
   * second instance must reconstruct byte-identically — it is a pinned row that
   * any instance resolves to the same answer by asking the catalog. Adding a
   * mirror would buy nothing and add a second thing that can go stale.
   *
   * NEVER throws. `resolveForGeneration` already fails open to the platform
   * shape; this catch is the belt-and-braces half for a broken injection.
   */
  private async ensureTemplateResolved(session: LiveSession): Promise<ResolvedDocumentTemplate> {
    if (!this.documentTemplateService) {
      session.templateSnapshot = PLATFORM_TEMPLATE;
      return PLATFORM_TEMPLATE;
    }

    try {
      // TASK-891 D7 — the slug the GOVERNING WORKFLOW names on its realtime summary node.
      // `resolveForGeneration` has always accepted it; nothing passed it, which is why the
      // traced session logged `templateId: null` and fell through to the platform shape
      // while its own workflow named a template. `null` keeps the previous behaviour
      // exactly: the tenant's default template, then the platform fallback.
      const lane = session.laneSnapshot !== undefined ? session.laneSnapshot : await (session.lanePromise ?? this.ensureLaneResolved(session));
      const laneSlug = realtimeDocumentTemplateSlug(lane);
      const resolved = await this.documentTemplateService.resolveForGeneration(session.tenantId, laneSlug ?? undefined);
      session.templateSnapshot = resolved;
      this.logger.log({
        message: 'Froze the live document template for this session',
        consultationId: session.consultationId,
        templateId: resolved.templateId,
        slug: resolved.slug,
        versionNumber: resolved.versionNumber,
        // WHERE the shape came from: the workflow's own node, or the tenant default.
        requestedSlug: laneSlug,
      });
      return resolved;
    } catch (error) {
      this.logger.error({
        message: 'Document template resolution failed — falling open to the platform shape',
        consultationId: session.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      session.templateSnapshot = PLATFORM_TEMPLATE;
      return PLATFORM_TEMPLATE;
    }
  }

  // ------------------------------------------------------------------
  // the substrate gate and the realtime lane
  // ------------------------------------------------------------------

  /**
   * Task 13 — MAY this engine document this consultation, and in WHICH mode?
   *
   * `startRecording` called `start()` after only an ownership and status check
   * (`consultation.controller.ts`), so the hardcoded flush ran for every
   * recording session no matter what the tenant had authored. That is the root
   * cause names, and this is the gate that closes it.
   *
   * Whether a tenant-authored graph took ownership at consultation open is the SAME durable
   * marker the loop plane already consults (`governing-engine.ts`): a well-formed
   * `governingEngine` on `Consultation.metadata`.
   *
   * ── THE CONTRACT ──────────────────────────────────────────────
   *
   * | Governed? | Frozen lane | Outcome |
   * |---|---|---|
   * | no | either | `true` — this engine documents the consultation |
   * | yes | `null` (LEGACY mode) | `false` — stand down, and tear the session down |
   * | yes | a lane (GRAPH mode) | `true` — run the GOVERNING definition's realtime lane |
   *
   * The middle row is task 13 unchanged, and for its original reason: the legacy flush
   * is a hardcoded script that writes a whole document, so running it beside a tenant-authored
   * graph is two engines writing one document.
   *
   * The bottom row is new, and it exists because the premise of a blanket stand-down stopped
   * being true. Since a session with `consultation.realtime.graphExecutor.enabled`
   * walks the REALTIME LANE of a published graph, and the durable interpreter deliberately SKIPS
   * every `lane: 'realtime'` node (`apps/harness/.../interpreter/workflow.py` `_dispatch_node`,
   * `reason="realtime_lane"`). Standing this engine down therefore left the realtime nodes —
   * live NER, the partial summary, the grammar pass — running in NEITHER engine. The realtime
   * lane only ever ran at all because the durable dispatch was failing and no marker was written.
   *
   * Exclusivity still holds in that row, and holds BY CONSTRUCTION rather than by this gate:
   * `buildRealtimeLane` admits only `REALTIME_NODE_TYPES`, so `consultation.persistDraft` and
   * every other durable writer is filtered out of the lane ( The one path that
   * could still put a legacy document on a governed consultation is `flush()`'s fall-back when
   * the lane cannot be WIRED, and {@link LiveDocumentationService.flush} refuses it for a
   * governed session — which is what `session.governedByTenantWorkflow` is frozen for.
   *
   * ── WHY THIS FAILS OPEN ─────────────────────────────────────────────────────
   * Identical reasoning to `LoopContextSignalService.standDownForTenantWorkflow`,
   * and it is worth restating rather than cross-referencing: being wrong in the
   * "stand down" direction leaves the encounter with NO documentation at all,
   * which is clinically worse than one documented by the default engine. So an
   * absent marker, a missing row, an unwired repository and a THROWING read are
   * all "this engine governs". Only a positively-read marker reaches the mode
   * question at all.
   */
  private async ensureSubstrateResolved(session: LiveSession): Promise<boolean> {
    if (!this.consultationRepository) {
      session.governedByTenantWorkflow = false;
      session.substrateAllowed = true;
      return true;
    }

    let governed = false;
    try {
      const consultation = await this.consultationRepository.findById(session.consultationId);
      governed = tenantWorkflowGoverns(consultation?.metadata);
      // TASK-932 §3.7 — freeze the declared summary language off the SAME row read, so the
      // operating frame costs no extra I/O on the start path.
      session.summaryLanguage = readSummaryLanguage(consultation?.metadata);
    } catch (error) {
      this.logger.warn({
        message: 'Governing-engine marker could not be read — this engine keeps the consultation so it is still documented',
        consultationId: session.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      session.governedByTenantWorkflow = false;
      session.substrateAllowed = true;
      return true;
    }

    session.governedByTenantWorkflow = governed;
    if (!governed) {
      session.substrateAllowed = true;
      return true;
    }

    // GOVERNED — so the MODE decides, and the mode IS the session's frozen lane. Read through
    // the memoized promise `start()` created immediately before this one, so the flag and the
    // graph resolve exactly once between them and the gate can never disagree with what runs.
    const lane = session.laneSnapshot !== undefined ? session.laneSnapshot : await (session.lanePromise ?? this.ensureLaneResolved(session));

    if (lane) {
      session.substrateAllowed = true;
      this.logger.log({
        message: 'Governed by a tenant workflow — running its REALTIME lane; the durable engine owns the document',
        consultationId: session.consultationId,
        laneSource: lane.source,
        definitionSlug: lane.definitionSlug,
        stageCount: lane.stages.length,
      });
      return true;
    }

    session.substrateAllowed = false;
    this.logger.log({
      message:
        'Live documentation stood down — a tenant-authored workflow governs this consultation and the legacy flush would write its document (substrate exclusivity)',
      consultationId: session.consultationId,
    });
    // Release the timers, the STT subscription and the owner lock. Leaving them
    // would keep a session alive that must never publish again.
    void this.stop(session.consultationId, { persistSnapshot: false }).catch(() => undefined);
    return false;
  }

  /**
   * The lane this session's flushes walk, frozen once at `start()`.
   *
   * Three tiers, and only the first is the tenant's:
   *   1. the tenant's assigned `consultation` graph, filtered to its realtime
   *      nodes — this is what makes authoring govern the live plane at all;
   *   2. {@link PLATFORM_REALTIME_LANE} when that resolves to nothing;
   *   3. `null` when the graph executor is not enabled for this tenant, which
   *      routes the flush down the LEGACY path.
   *
   * NEVER throws: every failure resolves to the platform lane or to legacy, and a
   * flush must not fail because a definition could not be read.
   */
  private async ensureLaneResolved(session: LiveSession): Promise<RealtimeLane | null> {
    const enabled = await this.isGraphExecutorEnabled(session.tenantId, session.consultationId);

    if (!enabled) {
      session.laneSnapshot = null;
      return null;
    }

    const lane = (await this.resolveTenantLane(session.tenantId, null, session.consultationId)).lane ?? PLATFORM_REALTIME_LANE;
    session.laneSnapshot = lane;
    this.logger.log({
      message: 'Froze the realtime lane for this session',
      consultationId: session.consultationId,
      laneSource: lane.source,
      definitionSlug: lane.definitionSlug,
      stageCount: lane.stages.length,
    });
    return lane;
  }

  /**
   * Effective `consultation.realtime.graphExecutor.enabled` for one tenant.
   *
   * Extracted from {@link ensureLaneResolved} so the read-out resolves the flag through
   * the same call a session does. A read-out with its own copy of this cascade would report the
   * engine an admin *configured* rather than the one that will *run*.
   */
  private async isGraphExecutorEnabled(tenantId: string, consultationId?: string): Promise<boolean> {
    // The code default is the last fallback in the cascade, and it is `false`:
    // absence resolves to the LEGACY engine, which is both fail-safe and today's
    // behaviour.
    if (!this.effectiveSettings) return CONSULTATION_GATE_DEFAULTS[CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY];
    try {
      const resolved = await this.effectiveSettings.resolveEffective(CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY, { tenantId });
      return resolved.value === true || resolved.value === 'true';
    } catch (error) {
      this.logger.warn({
        message: 'Realtime graph-executor flag could not be resolved — running the legacy flush for this session',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * This consultation's OWN selection -> assignment cascade -> ACTIVE PUBLISHED definition ->
   * compiled config -> lane.
   *
   * Returns the assignment's SOURCE alongside the lane because the two answer different
   * questions and only together explain what an admin is looking at: `assignmentSource` says
   * which TIER was consulted, `lane.source` says whether that tier produced an executable lane.
   * They can disagree — a tenant assignment pointing at a definition with no realtime nodes
   * resolves `tenant` + `platform-default`, which is precisely the silent misconfiguration this
   * read-out exists to surface.
   *
   * ## (G1) — the consultation tier, above the cascade
   *
   * let a clinician CHOOSE the workflow at session open. The choice was authorized and
   * honoured by the durable dispatcher, and then dropped here: this function consulted only
   * `workflowAssignments.resolve(...)`, so a clinician who selected workflow B got workflow A's
   * realtime nodes — different live NER, different partial summarization, different grammar
   * pass — while `GET /consultations/:id/workflow` reported B. Silent, and in the direction that
   * looks like success: a note is still produced.
   *
   * So the consultation's own selection is resolved FIRST, and the cascade is not consulted at
   * all when it resolves. Consulting it anyway and discarding the answer would put a second,
   * invisible slug in the logs for an operator to mistake for the one that ran.
   *
   * NEVER throws (unchanged): every failure — an unpublished, foreign or wrong-palette slug, a
   * graph contributing no realtime nodes, an unreadable row — falls back to the cascade, and the
   * cascade falls back to the platform lane. A consultation documented by the tenant default is a
   * better clinical outcome than one documented by nothing.
   */
  private async resolveTenantLane(
    tenantId: string,
    departmentId: string | null,
    consultationId?: string,
  ): Promise<{ lane: RealtimeLane | null; assignmentSource: LiveDocRealtimeAssignmentSource }> {
    // Kept as the FIRST statement so a deployment without the definition repository does exactly
    // what it did before — in particular it performs no consultation read, which is what keeps
    // "the marker is resolved once per session" true for those deployments.
    if (!this.workflowDefinitionRepository) return { lane: null, assignmentSource: 'platform-default' };

    if (consultationId) {
      const selected = await this.resolveConsultationSelectedLane(tenantId, consultationId);
      if (selected) return { lane: selected, assignmentSource: 'consultation' };
    }

    if (!this.workflowAssignments) return { lane: null, assignmentSource: 'platform-default' };
    try {
      const assignment = await this.workflowAssignments.resolve(tenantId, CORE_PALETTE_KEY, departmentId);
      if (!assignment.workflowDefinitionSlug) return { lane: null, assignmentSource: assignment.source };
      const definition = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, assignment.workflowDefinitionSlug);
      if (!definition?.compiledConfig) return { lane: null, assignmentSource: assignment.source };
      return { lane: buildRealtimeLane(definition.compiledConfig as never), assignmentSource: assignment.source };
    } catch (error) {
      this.logger.warn({
        message: 'Tenant realtime lane could not be resolved — serving the platform lane',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { lane: null, assignmentSource: 'platform-default' };
    }
  }

  /**
   * (G1) — the lane this CONSULTATION selected, or `null` to fall back to the cascade.
   *
   * ## Two recorded selections, read in this order
   *
   * | Key | Claim | Written when |
   * |---|---|---|
   * | `metadata.governingEngine` | the durable interpreter run OWNS this consultation | after a run actually started |
   * | `metadata.workflowSelection` | the clinician ASKED for this workflow | at consultation create |
   *
   * `governingEngine` first, because what actually governs beats what was asked for.
   *
   * AMENDED by. This used to add that the marker was "the weaker of the two here in
   * practice", because it ALSO made {@link ensureSubstrateResolved} stand the whole engine down,
   * so on a live session the lane it selected was never walked. That gate is now MODE-AWARE: in
   * GRAPH mode a governed session stays up and walks exactly the lane this function resolves
   * from the marker, so the marker is now the STRONGER of the two — it is both what governs and
   * what runs. `workflowSelection` remains what steers a session whose durable dispatch never
   * started (no run, so no marker), and both still feed the capabilities read-out.
   *
   * ## Re-authorized on every read, not trusted
   *
   * `Consultation.metadata` is client-writable at open, so both keys are re-resolved through the
   * tenant-scoped `findPublishedBySlug` and the same `consultationSelectionViolation` palette
   * predicate the gate uses. A forged value can therefore only ever name a workflow the
   * caller was already entitled to select, in their own tenant.
   */
  private async resolveConsultationSelectedLane(tenantId: string, consultationId: string): Promise<RealtimeLane | null> {
    if (!this.consultationRepository) return null;

    try {
      const consultation = await this.consultationRepository.findById(consultationId);
      // A consultation this tenant does not own must never choose this tenant's lane. The
      // repository read is already tenant-scoped in a request context; this is the second,
      // independent check, and it is also what the capabilities read-out turns into a 404.
      if (!consultation || consultation.tenantId !== tenantId) return null;

      const slug =
        readGoverningEngineMarker(consultation.metadata)?.workflowDefinitionSlug ||
        readWorkflowSelectionMarker(consultation.metadata)?.workflowDefinitionSlug;
      if (!slug) return null;

      const definition = await this.workflowDefinitionRepository!.findPublishedBySlug(tenantId, slug);
      if (!definition) {
        this.logger.warn({
          message: 'Consultation names a workflow that is not published for this tenant — falling back to the assignment cascade',
          consultationId,
          workflowDefinitionSlug: slug,
        });
        return null;
      }

      const violation = consultationSelectionViolation(definition);
      if (violation) {
        this.logger.warn({
          message: `Consultation names a workflow that ${violation} — falling back to the assignment cascade`,
          consultationId,
          workflowDefinitionSlug: slug,
        });
        return null;
      }

      const lane = buildRealtimeLane(definition.compiledConfig as never);
      if (!lane) {
        // Published, selectable, and contributes NO realtime node. Distinct from every case
        // above and worth its own line: the tenant authored a graph that governs the durable
        // plane only, and the live plane legitimately falls back.
        this.logger.warn({
          message: 'Consultation-selected workflow contributes no realtime nodes — falling back to the assignment cascade',
          consultationId,
          workflowDefinitionSlug: slug,
        });
        return null;
      }

      this.logger.log({
        message: 'Realtime lane resolved from the workflow THIS consultation selected, ahead of the assignment cascade',
        consultationId,
        workflowDefinitionSlug: slug,
      });
      return lane;
    } catch (error) {
      this.logger.warn({
        message: 'Consultation workflow selection could not be read — falling back to the assignment cascade',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * the read-out's 404 half.
   *
   * `resolveConsultationSelectedLane` is deliberately silent about a missing or foreign
   * consultation (a session must degrade, never fail). The READ-OUT must not be: an admin who
   * asks about a consultation that is not theirs has to be told, and told the same thing whether
   * the id is unknown or belongs to another tenant — 404 either way, so the status code is not an
   * existence oracle over the id space.
   */
  private async assertConsultationReadable(tenantId: string, consultationId: string): Promise<void> {
    if (!this.consultationRepository) return;

    const consultation = await this.consultationRepository.findById(consultationId);
    if (!consultation || consultation.tenantId !== tenantId) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }
  }

  /**
   * item 6 — which realtime capabilities are LIVE for a tenant.
   *
   * ## Why this exists
   *
   * Everything it reports already existed and none of it was readable. The lane source,
   * definition slug/version and per-node enabled state were computed at `start()` and written to
   * ONE log line; there was no API. So activating the runtime (flipping the kill-switch, landing
   * an assignment) produced no observable change an admin could confirm — and the failure mode
   * that matters here is silent: a lane that fell back to `PLATFORM_REALTIME_LANE` still produces
   * a note, so "my published graph governs consultations" and "my published graph governs
   * nothing" look identical from outside.
   *
   * ## It resolves, it does not describe
   *
   * The flag comes from {@link isGraphExecutorEnabled} and the lane from
   * {@link resolveTenantLane} — the SAME two calls `ensureLaneResolved` makes for a real session.
   * Nothing here is restated from a constant or a catalogue, which is what keeps the read-out
   * from drifting into a description of what the runtime is supposed to do.
   *
   * ## Its three answers
   *
   * | State | What it reports |
   * |---|---|
   * | Graph executor OFF | `laneSource: null`, `nodes: []` — there IS no lane; the legacy flush runs |
   * | ON, no resolvable assignment | `platform-default` and the platform lane's own nodes, because those genuinely execute |
   * | ON + assignment | `tenant-graph`, the slug and version, and the tenant's realtime nodes |
   * | ON + a consultation that SELECTED a workflow | `tenant-graph` with `assignmentSource: 'consultation'` — the clinician's own pick, not the tenant default |
   *
   * Tenant-scoped by construction: the caller's tenant is the only one resolved, and the
   * definition lookup is itself tenant-scoped, so a guessed slug cannot cross the boundary.
   *
   * ## — `consultationId`, and why it is not decoration
   *
   * Without it this answers "what would a NEW session for this tenant get". With it, it answers
   * "what would a session for THIS consultation get" — which since can differ, because
   * the clinician selected the workflow at open. A read-out that could only ever report the
   * tenant cascade would report the wrong graph for exactly the consultations someone is most
   * likely to be asking about. An unknown or foreign consultation id is a 404, never a silent
   * fall-through to the cascade: quietly answering the tenant question when the consultation
   * question was asked is how a misconfiguration gets confirmed as healthy.
   */
  async getRealtimeCapabilities(
    tenantId: string,
    departmentId: string | null = null,
    consultationId: string | null = null,
  ): Promise<LiveDocRealtimeCapabilitiesResponse> {
    // Before anything is described, including before the kill-switch answer: the caller asked
    // about a specific consultation, so "that consultation is not yours" is the answer they get.
    if (consultationId) await this.assertConsultationReadable(tenantId, consultationId);

    const graphExecutorEnabled = await this.isGraphExecutorEnabled(tenantId);

    if (!graphExecutorEnabled) {
      return {
        tenantId,
        departmentId,
        consultationId,
        graphExecutorEnabled: false,
        laneSource: null,
        definitionSlug: null,
        definitionVersionNumber: null,
        assignmentSource: 'platform-default',
        nodes: [],
      };
    }

    const { lane: tenantLane, assignmentSource } = await this.resolveTenantLane(tenantId, departmentId, consultationId ?? undefined);
    const lane = tenantLane ?? PLATFORM_REALTIME_LANE;
    // TASK-930 (G-1) — the same resolution the lane makes at run time, so `canonicalType` names
    // what a node WILL run rather than the TEXT_GENERATION fallback every slug-form ref reported.
    const agentTasks = await this.resolveLaneAgentTasks(lane, tenantId);

    return {
      tenantId,
      departmentId,
      consultationId,
      graphExecutorEnabled: true,
      laneSource: lane.source,
      definitionSlug: lane.definitionSlug,
      definitionVersionNumber: lane.definitionVersionNumber,
      assignmentSource,
      nodes: lane.stages.flatMap((stage) =>
        stage.nodes.map((node) => ({
          nodeId: node.nodeId,
          type: node.type,
          canonicalType: realtimeCapabilityOf(node.type, node.config, (slug) => agentTasks.get(slug)) ?? node.type,
          stageIndex: stage.stageIndex,
          enabled: node.enabled,
          togglable: realtimeNodeIsTogglable(node.type),
          onError: node.onError,
          timeoutMs: node.timeoutMs,
          maxAttempts: node.maxAttempts,
        })),
      ),
    };
  }

  /** Per-section store, constructed on first use (its repository is optional). */
  private sections(): DocumentSectionStore {
    this.sectionStore ??= new DocumentSectionStore(this.documentSectionRepository, this.secretsService);
    return this.sectionStore;
  }

  /** The frozen snapshot as mirrored in Redis, or null (absent / unusable / outage). */
  private async readStoredAgentSnapshot(consultationId: string): Promise<FrozenLiveAgentSnapshot | null> {
    try {
      const raw = await this.cacheService.get(this.agentKey(consultationId));
      if (!raw) return null;
      const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as FrozenLiveAgentSnapshot;
      // Guard against a truncated/legacy blob: the prompt bytes are what the
      // whole freeze exists to preserve, so anything without them is discarded
      // and we resolve fresh rather than serving an empty prompt.
      if (!parsed || typeof parsed.stableUserPrefix !== 'string' || typeof parsed.systemPrompt !== 'string') return null;
      return { ...parsed, toolPlan: parsed.toolPlan ?? DEFAULT_LIVE_TOOL_PLAN };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to read the stored live-agent snapshot — resolving fresh',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Mirror the frozen snapshot to Redis with the OWNER-LOCK TTL, refreshed by
   * the same fenced renewal loop — so a live session's pin can never expire
   * mid-session while the session itself is still owned.
   */
  private async storeAgentSnapshot(consultationId: string, snapshot: FrozenLiveAgentSnapshot): Promise<void> {
    try {
      await this.cacheService.setex(this.agentKey(consultationId), this.LOCK_TTL, JSON.stringify(snapshot));
    } catch (error) {
      // Non-fatal: the session keeps its in-memory freeze; only cross-instance
      // adoption degrades to a fresh (identical, because version-pinned) resolve.
      this.logger.warn({
        message: 'Failed to mirror the frozen live-agent snapshot to Redis',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The lineage block previously stamped onto the durable LIVE_SOAP_SNAPSHOT row, or null. */
  private async readDurableAgentLineage(consultationId: string): Promise<PersistedLiveAgentLineage | null> {
    try {
      const row = await this.findLiveSnapshotRow(consultationId);
      const agent = (row?.metaData as { agent?: PersistedLiveAgentLineage } | undefined)?.agent;
      if (!agent || !agent.promptTemplateId || agent.promptVersionNumber === null || agent.promptVersionNumber === undefined) return null;
      return agent;
    } catch {
      return null;
    }
  }

  /** The lineage subset of a snapshot — what is persisted, without duplicating prompt bytes. */
  private agentLineage(snapshot: FrozenLiveAgentSnapshot): PersistedLiveAgentLineage {
    return {
      agentId: snapshot.agentId,
      agentName: snapshot.agentName,
      promptTemplateId: snapshot.promptTemplateId,
      promptVersionNumber: snapshot.promptVersionNumber,
      resolvedFrom: snapshot.resolvedFrom,
      frozenAt: snapshot.frozenAt,
    };
  }

  /**
   * Stop watching. Resilient + cross-instance correct: when this
   * instance owns the session it flushes a final snapshot, optionally persists it,
   * and tears down locally; regardless of ownership it then signals the owner via
   * the control channel, releases the single-owner lock, and publishes the terminal
   * `closed` marker — so a `stop` routed to a non-owner instance still ends the
   * stream and frees the lock.
   *
   * ## What this does NOT do, in any mode
   *
   * It runs no note or summary FINALIZATION. Finalization of a governed consultation belongs to
   * the durable run's endpoint stage (`livedoc.stop` → `session.timeout` →
   * `harness.finalize` → `summary.finalize`), and `livedoc.stop` is that stage's FIRST action —
   * it calls this method. So there is no legacy finalization branch here to gate on the mode;
   * there never was one.
   *
   * What it does do, in every mode, is drain the backlog and persist the `LIVE_SOAP_SNAPSHOT`
   * (`persistDurableSnapshot`). That row is the durable engine's INPUT, not a competing draft:
   * `harness.finalize` reads it as `preSummaryText` (`harness-internal.service.ts`
   * `loadLiveSoapSnapshot`), while the durable draft is a `RAW_SUMMARY` marked `HARNESS_DRAFT`.
   * Suppressing it for a governed consultation would delete the warm start the finalizer is
   * asking for, so `persistSnapshot` is honoured exactly as before. The drain loop is a
   * `flush(force)` loop, which is where the governed legacy fall-through guard does its work.
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
      // TEXT down / nothing new), and a hard iteration cap as a final safety net so a
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
    // Explicit kind filter: the ContextAdded gate now also fires
    // for TRANSCRIPT/STRUCTURED, which this consumer was never written for.
    if (!LIVE_DOC_CONTEXT_TYPES.has(payload.contextType)) return;

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
  // Flush — TEXT + NLP aggregation, publish
  // ------------------------------------------------------------------

  /**
   * TASK-891 B3 — the SINGLE-FLIGHT gate in front of {@link runFlush}.
   *
   * ## The starvation this closes
   *
   * `runFlush` claims a new generation and aborts the previous one on every entry, and
   * the min-interval throttle measures from the previous flush's START. A realtime SOAP
   * generation takes 14 s idle and 20–52 s under load against a 4 s interval, so every
   * transcript delta superseded a generation that was still running. Measured on
   * `hope-v2-dev`: 55 generations in 10½ minutes, **53 dropped as stale, 2 completed**,
   * and `DocumentSection` empty cluster-wide. The engine was busy continuously and
   * produced nothing.
   *
   * ## The rule
   *
   * ONE generation in flight per session. A flush requested while one is running records
   * a coalesce and returns the note the clinician is already reading; the trailing re-run
   * is scheduled when the in-flight generation completes, so the newer transcript is
   * folded into the NEXT generation rather than starting a competing one. **A slow model
   * degrades the cadence, never the output.**
   *
   * `force` (the final flush from `stop()`) deliberately bypasses the gate: there is no
   * later flush for it to coalesce into, so it must still supersede. That is the genuine
   * supersession `isStale()` exists for, and it is unchanged.
   */
  async flush(consultationId: string, opts?: { force?: boolean }): Promise<LiveSummaryEventDto | null> {
    const session = this.sessions.get(consultationId);
    if (!session) return null;

    if (opts?.force) return this.runFlush(consultationId, opts);

    if (session.inFlight) {
      session.coalescedFlush = true;
      // The last published note, not null: this is a caller asking for the current
      // state while a fresher one is being produced, which is exactly what it holds.
      return session.lastPayload ?? null;
    }

    session.inFlight = true;
    try {
      return await this.runFlush(consultationId, opts);
    } finally {
      session.inFlight = false;
      if (session.coalescedFlush) {
        session.coalescedFlush = false;
        // Only for a session that still exists: a `stop()` racing the completion must
        // not leave a timer behind.
        if (this.sessions.get(consultationId) === session) this.scheduleThrottledFlush(session);
      }
    }
  }

  /**
   * Recompute the running summary + entities and publish them. Reached through the
   * single-flight gate above; `stop()`'s forced final flush is the one caller that
   * bypasses it.
   *
   * `force` (used by `stop`) bypasses the min-interval throttle for the final flush.
   * Overlapping flushes are made safe by a per-session generation id: a newer flush
   * aborts the prior in-flight TEXT/NLP call and only the latest generation may
   * publish, advance the incremental cursor, or persist.
   */
  private async runFlush(consultationId: string, opts?: { force?: boolean }): Promise<LiveSummaryEventDto | null> {
    const session = this.sessions.get(consultationId);
    if (!session) return null;
    this.clearTimer(session);

    const transcript = session.transcriptParts.join(' ').trim();
    const notes = session.contextNotes
      .map((n) => n.text)
      .join('\n')
      .trim();
    if (!transcript && !notes) return null;

    // Min-interval throttle (P0-A): coalesce a burst into a single trailing re-run so
    // a busy session never exceeds one TEXT call per `LIVE_DOC_MIN_INTERVAL_MS`.
    const elapsed = Date.now() - session.lastFlushAt;
    if (!opts?.force && elapsed < this.minIntervalMs) {
      this.scheduleThrottledFlush(session);
      return session.lastPayload ?? null;
    }

    session.lastFlushAt = Date.now();
    session.pendingSegments = 0;

    //  — a memo scoped to THIS flush. Not to the session: a guard
    // verdict is a statement about a specific text at a specific moment, so
    // carrying it across flushes would serve a verdict computed against an older
    // note.
    const guards = new GuardMemo();

    // The session's FROZEN agent. Resolved once at `start`;
    // from the second flush on this is a settled promise, i.e. a microtask and
    // ZERO blocking I/O. The very first flush of a session may await the
    // in-flight start-time resolution (bounded, ≤4 reads, once per session).
    // `ensureAgentResolved` never rejects, so this can never fail a flush.
    const agent = session.agentSnapshot ?? (session.agentSnapshot = await (session.agentPromise ?? this.ensureAgentResolved(session)));

    // the session's FROZEN document template, resolved and cached
    // with exactly the same discipline as the agent above. `ensureTemplateResolved`
    // never rejects (the service's own `resolveForGeneration` fails open to the
    // platform shape), so this can never fail a flush.
    const template = session.templateSnapshot ?? (session.templateSnapshot = await (session.templatePromise ?? this.ensureTemplateResolved(session)));

    // task 13 — the SUBSTRATE GATE. Awaited here rather than checked at
    // `start()` because `start` is synchronous for the recording controller;
    // resolving it is a row read. `false` means this engine publishes NOTHING for this
    // consultation — the fix for "the hardcoded loop runs regardless of what the tenant
    // authored".
    //
    // `false` now means "governed AND in legacy mode". A governed session in
    // GRAPH mode resolves `true` and walks the governing definition's realtime lane below;
    // `session.governedByTenantWorkflow` is what keeps it off the legacy branch.
    const substrateAllowed =
      session.substrateAllowed ?? (session.substrateAllowed = await (session.substratePromise ?? this.ensureSubstrateResolved(session)));
    if (!substrateAllowed) return null;

    // the session's FROZEN realtime lane. `null` routes this flush
    // down the LEGACY path (the per-tenant flag is off, or its resolution failed).
    const lane =
      session.laneSnapshot !== undefined
        ? session.laneSnapshot
        : (session.laneSnapshot = await (session.lanePromise ?? this.ensureLaneResolved(session)));

    // Resolve the effective agentic.context.* knobs for THIS flush.
    // Refreshing here (rather than at construction) is what makes the control plane
    // real: a super admin's registry write governs the very next flush, with no
    // redeploy. It also refreshes the snapshot the synchronous ingest/debounce
    // paths read.
    const agenticContext = await this.resolveAgenticContext(session.tenantId);
    // TASK-891 B1 — the realtime TEXT budget, resolved for THIS flush by the same
    // control-plane contract: a super admin's write governs the next flush, no redeploy.
    await this.resolveTextTimeoutMs(session.tenantId);
    await this.resolveGroundednessEnabled(session.tenantId);

    // Supersede any in-flight generation: abort its HTTP calls and claim a new id.
    const myGeneration = ++session.generation;
    session.abortController?.abort();
    const abortController = new AbortController();
    session.abortController = abortController;
    const signal = abortController.signal;
    const isStale = (): boolean => this.sessions.get(consultationId) !== session || session.generation !== myGeneration;

    // Incremental prompt (P0-B): refine the prior note with only the new
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
      // The prior note already carries everything older, so on overflow the
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
          ? 'Live summary transcript windowed — older backlog elided (B3)'
          : 'Live summary transcript delta truncated — carrying overflow forward (C5-04)',
        consultationId,
        truncatedDeltaCount: session.truncatedDeltaCount,
        deltaChars: delta.length,
        carriedForwardParts: flushUpTo - deltaEnd,
        elidedParts,
      });
    }
    const priorNote = session.lastPayload?.runningSummary ?? '';
    // The stable lead-in now comes from the FROZEN snapshot rather than the
    // module constant. Prefix-cache friendliness is preserved BY CONSTRUCTION:
    // the prefix is frozen per session, so it stays byte-identical across every
    // flush — exactly the property the constant used to provide.
    const promptText = this.buildTextUserPrompt(
      priorNote,
      delta || transcript,
      notes,
      elidedParts > 0,
      this.stablePrefixFor(agent, template),
      template.compiled.title,
      this.operatingFrame(template, session.summaryLanguage),
    );

    // TEXT first (a structured S/O/A/P running note), then NER over the resulting
    // `runningSummary` (the canonical text the entity highlight offsets index — so it
    // must be produced before NER runs). Both calls retain the last-good value if the
    // service is down.
    let sections = session.lastPayload?.sections ?? [];
    let runningSummary = priorNote;
    let textFailed = false;
    let textLatencyMs = 0;
    // AD-1 generation stats for this flush (null unless TEXT
    // returned a stats block); surfaced on the payload as `metadata.stats`.
    let textStats: LiveSummaryStatsDto | null = null;
    // bounded JSON auto-repair telemetry. When the first
    // structured response is not valid SOAP JSON we do EXACTLY ONE corrective
    // retry; the repair TEXT call is recorded as its own ordered LLM_CALL step.
    let textRepaired = false;
    let repairLatencyMs = 0;
    let repairStats: LiveSummaryStatsDto | null = null;
    // ── — GRAPH MODE ────────────────────────────────────────────────
    // The session's frozen LANE decides what runs. A null lane is the LEGACY
    // path below, which stays executable until trajectory parity is proven on the
    // same transcript — this ticket does not remove it.
    //
    // The two branches produce the SAME locals, which is deliberate: everything
    // downstream (grounding, groundedness, publish, persist, stats, trajectory) is
    // shared, so the only thing that varies is HOW the note and the entities were
    // produced. That is also what makes the parity diff meaningful.
    // The capture node's output for THIS flush — the same `delta || transcript`
    // the legacy path feeds NER, which is what makes the platform lane's
    // behaviour identical rather than merely similar.
    session.pendingGraphTranscript = delta || transcript;
    const graph = lane
      ? await this.runGraphLane(session, lane, {
          buildPrompt: (sourceText) =>
            this.buildTextUserPrompt(
              priorNote,
              sourceText,
              notes,
              elidedParts > 0,
              this.stablePrefixFor(agent, template),
              template.compiled.title,
              this.operatingFrame(template, session.summaryLanguage),
            ),
          agent,
          template,
          signal,
          isStale,
        })
      : null;
    if (graph === 'stale') return this.dropStale(session);

    // a GOVERNED consultation NEVER falls through to the legacy engine.
    //
    // `runGraphLane` returns null when the tenant's lane could not be WIRED (a
    // `RealtimeBindingError`), and for an ungoverned session that legitimately means "publish
    // something rather than nothing". For a governed one it would mean a hardcoded document
    // written beside the one the durable run owns — the exact hazard the substrate gate exists
    // to prevent, arriving through the one door the gate no longer closes. So: publish nothing,
    // persist nothing, advance no cursor. The next flush walks the lane again, and the binding
    // error is already logged at ERROR by `runGraphLane`.
    if (!graph && session.governedByTenantWorkflow) {
      this.logger.warn({
        message: 'Governing workflow’s realtime lane could not be walked — publishing nothing rather than falling back to the legacy engine',
        consultationId,
        definitionSlug: lane?.definitionSlug ?? null,
      });
      return null;
    }

    if (graph) {
      if (graph.sections.length > 0) {
        sections = graph.sections;
        runningSummary = graph.runningSummary;
        session.flushedTranscriptCount = deltaEnd;
      }
      textFailed = graph.textFailed;
      textLatencyMs = graph.textLatencyMs;
      textStats = graph.textStats;
      textRepaired = graph.textRepaired;
      repairLatencyMs = graph.repairLatencyMs;
      repairStats = graph.repairStats;
    }

    if (!graph) {
      try {
        // Bounded JSON auto-repair: the strict parser is `parseDocumentJson` (null on
        // a JSON/shape failure); the tolerant `parseDocumentSections` prose parser is the
        // final fallback. A retry only runs when `response_format` was actually
        // sent (structured) — an engine that ignores it returns prose by design, so
        // a retry could never yield JSON and is skipped. The corrective instruction
        // is appended (not prepended) to keep the prefix-cache-stable lead-in intact.
        const outcome = await generateJsonWithRepair<LiveSummarySectionDto[], LiveSoapCall>({
          generate: async (corrective) => {
            const startedAt = Date.now();
            const { text, stats, structured } = await this.callText(
              promptText,
              session.tenantId,
              signal,
              corrective,
              agent,
              template.compiled,
              undefined,
              session.consultationId,
            );
            return { text, stats, structured, latencyMs: Date.now() - startedAt };
          },
          parseStrict: (text) => {
            const parsed = parseDocumentJson(text, template.compiled);
            return parsed && parsed.length > 0 ? parsed : null;
          },
          parseTolerant: (text) => parseDocumentSections(text, template.compiled),
          // Retry only a genuine malformed-JSON attempt: structured output was
          // requested AND the text opens a JSON object. Clean prose (no leading
          // `{`) is served by the tolerant regex parser with no wasted regen.
          shouldRepair: (first) => first.structured && looksLikeJsonObject(first.text),
        });
        if (isStale()) return this.dropStale(session);

        const [firstCall, repairCall] = outcome.calls;
        textLatencyMs = firstCall.latencyMs;
        textStats = firstCall.stats;
        textRepaired = outcome.repaired;
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
        textFailed = true;
        this.logger.warn({
          message: 'TEXT running-summary call failed',
          consultationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Extract-from-source + entity-ground (SPEER). Run NER over the RAW
    // TRANSCRIPT DELTA (the same `delta || transcript` that feeds TEXT), NOT the generated note:
    // the LLM running note carries a material hallucination base rate, so NER over the note
    // laundered invented findings/medications into first-class clinical entities. The
    // transcript-sourced entities are then GROUNDED back to the rendered note (below) — a
    // mention that survives only in the note with no transcript support is never a candidate
    // here (NER never sees the note) and is therefore never surfaced.
    //
    // WHICH tools run is now the session's frozen `toolPlan`
    // (OD-5(b): config-driven, NOT a model-initiated loop). `ner` and `vitals`
    // are two plan keys served by ONE executor and ONE HTTP call — disabling
    // `vitals` filters the block off that same response rather than saving a
    // request, and disabling BOTH is what skips the call entirely. The registry
    // context receives `nerSourceText` and nothing else, so the anti-laundering
    // rule above is enforced by the executor's input TYPE, not by convention.
    // in GRAPH MODE the entity extraction was performed by the lane's
    // `consultation.extractEntities` node, bound to its declared `in: transcript`
    // port. The anti-laundering rule is enforced there by the executor's port-type
    // check, which refuses `document -> transcript` outright.
    const nerSourceText = delta || transcript;
    const priorEntities = session.lastPayload?.entities ?? [];
    let extracted: LiveSummaryEntityDto[] = [];
    let flushVitals: LiveSummaryVitalsDto | undefined;
    let nlpFailed = false;
    let nlpLatencyMs = 0;
    let nlpRan = false;
    // Lane N — the tenant instruction's IMPORTANT FINDINGS for this flush. Only graph mode can
    // produce them: they come from a node a tenant AUTHORED, and the legacy engine has no node to
    // author. A lane without one yields `[]`, which is why every pre-Lane-N session is untouched.
    let flushFindings: LiveSummaryEntityDto[] = [];
    if (graph) {
      extracted = graph.entities;
      flushFindings = graph.findings;
      flushVitals = graph.vitals;
      nlpFailed = graph.nlpFailed;
      nlpLatencyMs = graph.nlpLatencyMs;
      nlpRan = graph.nlpRan;
    }
    if (!graph) {
      const nerEnabled = this.toolRegistry.isEnabled(agent.toolPlan, 'ner');
      const vitalsEnabled = this.toolRegistry.isEnabled(agent.toolPlan, 'vitals');
      const nlpStartedAt = Date.now();
      try {
        if (nerSourceText && (nerEnabled || vitalsEnabled)) {
          nlpRan = true;
          const nlpResult = await this.toolRegistry.extraction().execute({ sourceText: nerSourceText, tenantId: session.tenantId }, signal);
          extracted = nerEnabled ? nlpResult.entities : [];
          flushVitals = vitalsEnabled ? nlpResult.vitals : undefined;
          nlpLatencyMs = Date.now() - nlpStartedAt;
        }
      } catch (error) {
        if (isStale()) return this.dropStale(session);
        nlpFailed = true;
        this.logger.warn({ message: 'NLP entity call failed', consultationId, error: error instanceof Error ? error.message : String(error) });
      }
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
    // C4: gated by the frozen plan — `enabled: null` (the default) defers to
    // `LIVE_DOC_GROUNDEDNESS_ENABLED`, exactly as before.
    if (this.toolRegistry.isEnabled(agent.toolPlan, 'groundedness') && runningSummary) {
      const groundednessStartedAt = Date.now();
      const guardSource = notes ? `${transcript}\n${notes}` : transcript;
      //  — through the per-FLUSH guard memo. With one document
      // this changes nothing (one call, one miss); with several documents drawn
      // from one transcript the same guard is asked the same question repeatedly,
      // and this is what stops that becoming N groundedness round-trips per turn.
      // The key carries the guard's CONFIG, so two thresholds stay two verdicts.
      const guardConfig = { timeoutMs: this.groundednessTimeoutMs, maxRetries: this.groundednessMaxRetries };
      groundedness = await guards.resolve(GUARDRAIL_GROUNDEDNESS_TOOL, guardConfig, `${runningSummary}\u0000${guardSource}`, () =>
        this.toolRegistry.guardrail().execute({ summary: runningSummary, sourceText: guardSource, tenantId: session.tenantId }, signal),
      );
      groundednessLatencyMs = Date.now() - groundednessStartedAt;
      if (isStale()) return this.dropStale(session);
    }

    // Ground the union of prior + newly-extracted transcript entities against the CURRENT note
    // . Merging with the prior set preserves the running highlight set across flushes
    // (NER only sees the new delta, but the note is cumulative — recall), and always re-grounding
    // against the current `runningSummary` keeps offsets valid even on the NLP-failure fallback.
    const entities = this.groundEntitiesToNote([...priorEntities, ...extracted], runningSummary);
    // Lane N — findings go through the SAME grounding function, deliberately. A finding whose
    // surface form does not survive in the rendered note is DROPPED for the identical reason an
    // entity is: there is nothing to anchor a highlight to, and — because the findings pass reads
    // the transcript and never the note — a note-only (hallucinated) mention was never a
    // candidate. Merging with the prior set preserves the running highlight across flushes, since
    // each pass only sees the new delta while the note is cumulative.
    const priorFindings = session.lastPayload?.findings ?? [];
    const findings = this.groundEntitiesToNote([...priorFindings, ...flushFindings], runningSummary);
    // Vitals accumulate across flushes (NER only sees the new delta) — a later
    // non-null value wins, prior values persist. Absent until one is seen.
    const vitals = this.mergeVitals(session.lastPayload?.vitals, flushVitals);

    const agentMetadata: LiveSummaryAgentDto | null = agent.promptTemplateId
      ? {
          id: agent.agentId,
          name: agent.agentName,
          promptTemplateId: agent.promptTemplateId,
          promptVersionNumber: agent.promptVersionNumber,
          resolvedFrom: agent.resolvedFrom,
        }
      : null;

    const payload: LiveSummaryEventDto = {
      consultationId,
      runningSummary,
      sections,
      entities,
      // Additive and OMITTED when empty, so a tenant whose lane runs no important-findings node
      // sees a byte-identical payload to the one it saw before Lane N.
      ...(findings.length > 0 ? { findings } : {}),
      lastSegmentId: session.lastSegmentId,
      ...(groundedness ? { groundedness } : {}),
      // attach the AD-1 stats when present; omit the envelope
      // entirely on a stats-less flush (TEXT failure / legacy cache hit) so the
      // feed degrades cleanly rather than publishing an empty metadata block.
      // The session's agent identity, additively, under the same
      // optional envelope. Emitted only when a GOVERNED tier resolved: on the
      // code-default tier there is no agent identity to report, and inventing a
      // metadata block there would change the published shape for a tenant that
      // configured nothing (the C3 behavior-identical invariant).
      ...(textStats || agentMetadata
        ? { metadata: { ...(textStats ? { stats: textStats } : {}), ...(agentMetadata ? { agent: agentMetadata } : {}) } }
        : {}),
      ...(vitals ? { vitals } : {}),
      ...(textFailed ? { textFailed: true } : {}),
      updatedAt: new Date().toISOString(),
    };

    session.lastPayload = payload;
    await this.safePublish(consultationId, payload);
    await this.persistDurableSnapshot(session, payload, { force: false });
    // the per-SECTION plane, ADDITIVE to the whole-document
    // payload above so every existing consumer is untouched. Only in graph mode:
    // the legacy engine's contract is "one document, global offsets", and
    // emitting section patches from it would claim a granularity it does not have.
    if (graph) {
      await this.publishSectionPatches(session, {
        sections,
        runningSummary,
        entities,
        findings,
        groundedness,
        template,
        generation: myGeneration,
        // TASK-891 B5 — WHY this flush produced nothing, when it produced nothing. The
        // summary node's own reason wins over any other node's: it is the one that
        // decides whether there is a note at all.
        degradeReason: realtimeDegradeReason(graph.run, lane),
      });
    }

    session.flushCount += 1;
    // PHI-safe metrics (P2): sizes/latencies/counts only — never transcript or summary text.
    this.logger.log({
      message: 'Live summary flush',
      consultationId,
      generation: myGeneration,
      flushCount: session.flushCount,
      textLatencyMs,
      nlpLatencyMs,
      textFailed,
      nlpFailed,
      entityCount: entities.length,
      // PHI-safe: a COUNT of findings, never a finding.
      findingCount: findings.length,
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
      textLatencyMs,
      nlpLatencyMs,
      textFailed,
      nlpFailed,
      entityCount: entities.length,
      sectionCount: sections.length,
      summaryChars: runningSummary.length,
      // TASK-891 B4 — WHICH node degraded and why, beside the two boolean stage flags.
      // Empty on a clean flush and on the legacy engine, which has no nodes.
      nodeDegrades: graph ? graph.run.events.map(({ nodeId, type, status, reason }) => ({ nodeId, type, status, reason })) : [],
    });

    // Emit the ordered per-flush trajectory. Non-fatal: a
    // trajectory failure NEVER breaks the live flush (recordFlushTrajectory
    // swallows + logs). Runs after the payload is published/persisted.
    await this.recordFlushTrajectory(session, {
      textStats,
      textFailed,
      textLatencyMs,
      textRepaired,
      repairStats,
      repairLatencyMs,
      // C4: the TOOL_CALL step records exactly the calls this flush made — a
      // plan-disabled extraction records no step (it did not run).
      nlpRan,
      nlpFailed,
      nlpLatencyMs,
      groundedness,
      groundednessLatencyMs,
    });

    return payload;
  }

  /**
   * run one flush through the GRAPH EXECUTOR and project the result
   * onto the same locals the legacy path produces.
   *
   * The projection is the point. Everything downstream of this method — entity
   * grounding, the groundedness gate, publish, durable snapshot, stats and the
   * trajectory — is SHARED between the two engines, so a trajectory diff between
   * them isolates exactly one variable: how the note and the entities were
   * produced. If the projection were lossy, the parity evidence would be too.
   *
   * Returns `'stale'` when a newer flush superseded this one (the caller drops
   * the generation), or `null` when the lane could not be walked at all — in
   * which case the caller falls through to the legacy path rather than
   * publishing an empty note.
   */
  private async runGraphLane(
    session: LiveSession,
    lane: RealtimeLane,
    ctx: {
      /**
       * Builds the TEXT prompt from a node's BOUND `sourceText`.
       *
       * A function, not a prebuilt string, because the whole point of task 5 is
       * that a step's input comes from its declared port. On the platform lane
       * the bound value IS `delta || transcript`, so the bytes are identical to
       * legacy — but on a tenant lane whose generation node is wired to something
       * else, the prompt follows the wiring instead of silently ignoring it.
       */
      buildPrompt: (sourceText: string) => string;
      agent: FrozenLiveAgentSnapshot;
      template: ResolvedDocumentTemplate;
      signal: AbortSignal;
      isStale: () => boolean;
    },
  ): Promise<GraphFlushProjection | 'stale' | null> {
    // Honour the session's frozen tool plan on the PLATFORM lane. A tenant graph
    // governs itself through each node's own `enabled` config; the platform lane
    // has no author, so the plan is what expresses "this tenant disabled NER" —
    // and without this overlay, enabling the graph executor would silently
    // re-enable a tool a tenant had turned off.
    const effectiveLane = lane.source === 'platform-default' ? this.applyToolPlanToPlatformLane(lane, ctx.agent) : lane;

    let textLatencyMs = 0;
    let textStats: LiveSummaryStatsDto | null = null;
    let textRepaired = false;
    let repairLatencyMs = 0;
    let repairStats: LiveSummaryStatsDto | null = null;
    let parsedSections: LiveSummarySectionDto[] = [];

    const capabilities: RealtimeCapabilities = {
      // task 14 / — capture PRODUCES the transcript.
      // The declared `out: transcript` port was design intent the durable
      // activity never kept (it emits `{action, consultationId}`), which left the
      // consultation palette with no producer of `transcript` and made
      // `extractEntities`' required input unsatisfiable. Here it is real: the
      // value is the live ASR stream this session ingested.
      transcribe: async () => ({ transcript: session.pendingGraphTranscript ?? '', pipelineId: session.sttPipelineId ?? null }),

      // TASK-930 (G-1) — WHICH capability a `core.agent` runs is a property of the AGENT, and a
      // slug-form reference carries no task, so the host must resolve it. Without this the lane
      // fell back to TEXT_GENERATION for every node: the ASR and NER nodes of the seeded graphs
      // generated notes instead of transcribing and extracting.
      resolveAgent: async (ref) => this.resolveRealtimeAgentView(ref, session.tenantId),

      generateDocument: async (input, signal) => {
        // Built from the node's BOUND `sourceText`, not from an expression this
        // method happened to have in scope. On the platform lane that bound value
        // IS `delta || transcript`, so the prompt bytes are identical to legacy —
        // parity by construction, not by coincidence.
        const promptText = ctx.buildPrompt(input.sourceText);
        // TASK-876 — a `core.agent` node names the agent it runs. Resolved HERE (the host),
        // once per call: explicit slug + version pin, FAIL CLOSED on drift or an unresolvable
        // slug — the throw degrades the node with a named reason and nothing is generated on
        // the tenant default in its place. A legacy summary node carries no ref and keeps the
        // assigned-agent path inside `callText`.
        const textAgent = await this.resolveRealtimeTextAgent(input, session.tenantId, effectiveLane);
        const outcome = await generateJsonWithRepair<LiveSummarySectionDto[], LiveSoapCall>({
          generate: async (corrective) => {
            const startedAt = Date.now();
            const { text, stats, structured } = await this.callText(
              promptText,
              session.tenantId,
              signal,
              corrective,
              ctx.agent,
              ctx.template.compiled,
              textAgent,
              session.consultationId,
            );
            return { text, stats, structured, latencyMs: Date.now() - startedAt };
          },
          parseStrict: (text) => {
            const parsed = parseDocumentJson(text, ctx.template.compiled);
            return parsed && parsed.length > 0 ? parsed : null;
          },
          parseTolerant: (text) => parseDocumentSections(text, ctx.template.compiled),
          shouldRepair: (first) => first.structured && looksLikeJsonObject(first.text),
        });

        const [firstCall, repairCall] = outcome.calls;
        textLatencyMs = firstCall.latencyMs;
        textStats = firstCall.stats;
        textRepaired = outcome.repaired;
        if (repairCall) {
          repairLatencyMs = repairCall.latencyMs;
          repairStats = repairCall.stats;
        }
        parsedSections = outcome.value;
        return { text: buildRunningSummary(outcome.value), sections: outcome.value, stats: firstCall.stats, repaired: outcome.repaired };
      },

      // Lane R (R1) — the live GRAMMAR pass. Reads the node's own config (the prompt binding)
      // and the entities the SAME flush already produced, so it costs one model call and no
      // second NER round trip.
      proposeCorrections: async (input, signal) => this.proposeCorrections(input, session.consultationId, signal),

      // Lane N — IMPORTANT FINDINGS, by the TENANT'S OWN instruction. Same shape as the grammar
      // pass and for the same reason: the instruction is bound to the node, so what counts as
      // important is a per-tenant, per-node decision and never a constant in this service.
      extractFindings: async (input, signal) => this.extractImportantFindings(input, signal),

      extractEntities: async (input, signal) => {
        // ONE executor, ONE HTTP call — `vitals` is a projection of the same
        // `nlp.classify-tokens` response, exactly as it always was.
        const result = await this.toolRegistry.extraction().execute({ sourceText: input.sourceText, tenantId: input.tenantId }, signal);
        const vitalsEnabled = this.toolRegistry.isEnabled(ctx.agent.toolPlan, 'vitals');
        const nerEnabled = this.toolRegistry.isEnabled(ctx.agent.toolPlan, 'ner');
        return { entities: nerEnabled ? result.entities : [], vitals: vitalsEnabled ? result.vitals : undefined };
      },
    };

    let run: RealtimeRunResult;
    try {
      run = await runRealtimeLane({
        lane: effectiveLane,
        consultationId: session.consultationId,
        tenantId: session.tenantId,
        capabilities,
        isStale: ctx.isStale,
        signal: ctx.signal,
      });
    } catch (error) {
      // A BINDING error is a contract violation in the tenant's graph, not a bad
      // day for a model. It must be LOUD and it must not silently downgrade to a
      // note produced some other way — which is why the caller falls back to the
      // legacy engine and this is logged at ERROR.
      this.logger.error({
        message: 'Realtime lane could not be wired — falling back to the legacy flush for this session',
        consultationId: session.consultationId,
        laneSource: lane.source,
        definitionSlug: lane.definitionSlug,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    if (ctx.isStale()) return 'stale';

    // Degrade is NEVER silent: every non-success outcome is published to the
    // clinician's control channel as a typed event. Silent degradation to an
    // empty note is exactly why the 2026-08-25 outage went unnoticed for hours.
    if (run.events.length > 0) {
      await this.publishDegradeEvents(session, run);
    }

    // Read the outcomes back by CAPABILITY, never by node type. Since TASK-893 every realtime
    // node is a `core.agent` and the type says nothing about what it did, so a type match would
    // read the transcription node's output as the note. The outcome's own `capability` is what
    // RAN and wins; the lane-derived expectation covers the outcomes that never got that far
    // (a degraded or timed-out node carries no capability, and `textFailed` / `nlpFailed` are
    // exactly the flags that have to attribute those).
    const expected = realtimeCapabilityIndex(effectiveLane);
    const ranAs = (o: RealtimeRunResult['outcomes'][number], capability: RealtimeCapabilityKey): boolean =>
      (o.capability ?? expected.get(o.nodeId)) === capability;
    const summarize = run.outcomes.find((o) => ranAs(o, 'generateDocument'));
    const extract = run.outcomes.find((o) => ranAs(o, 'extractEntities'));
    const extractOutput = extract?.status === 'succeeded' ? extract.output : undefined;
    // Lane N — IMPORTANT FINDINGS. No handler produces this capability since the `core.*`
    // retirement removed `agent.important_findings`, so this stays empty until one does; the
    // lookup is kept keyed on the capability rather than deleted so wiring a handler is enough.
    const findingsNode = run.outcomes.find((o) => ranAs(o, 'extractFindings'));
    const findingsOutput = findingsNode?.status === 'succeeded' ? findingsNode.output : undefined;

    return {
      sections: summarize?.status === 'succeeded' ? parsedSections : [],
      runningSummary: summarize?.status === 'succeeded' ? buildRunningSummary(parsedSections) : '',
      textFailed: summarize !== undefined && summarize.status !== 'succeeded' && summarize.status !== 'skipped',
      textLatencyMs,
      textStats,
      textRepaired,
      repairLatencyMs,
      repairStats,
      entities: (extractOutput?.entities as LiveSummaryEntityDto[] | undefined) ?? [],
      findings: (findingsOutput?.findings as LiveSummaryEntityDto[] | undefined) ?? [],
      vitals: extractOutput?.vitals as LiveSummaryVitalsDto | undefined,
      nlpRan: extract !== undefined && extract.status !== 'skipped',
      nlpFailed: extract !== undefined && extract.status !== 'succeeded' && extract.status !== 'skipped',
      nlpLatencyMs: extract?.durationMs ?? 0,
      run,
    };
  }

  /**
   * persist and stream this flush's sections.
   *
   * Two things happen per section, in this order: the row is written under
   * per-section OCC (so a CONFIRMED section a clinician touched is never
   * overwritten), and the accepted patch is published as a `section.patch` event.
   * A REFUSED write publishes nothing — the clinician's own text is already what
   * the feed shows, and re-broadcasting the model's rejected version would make
   * the panel flicker between the two.
   *
   * Annotations are RE-ANCHORED to section-local offsets first. That is the whole
   * fix: the global offsets on the whole-document payload are valid only while
   * there is exactly one document rebuilt whole each flush, and the moment
   * sections stream independently an earlier section growing invalidates every
   * offset after it.
   *
   * Never throws. Section persistence is additive to a feed the clinician is
   * already reading; losing it must not lose the flush.
   */
  private async publishSectionPatches(
    session: LiveSession,
    ctx: {
      sections: LiveSummarySectionDto[];
      runningSummary: string;
      entities: LiveSummaryEntityDto[];
      /** Lane N — annotated under their own `finding` kind, never merged into `entities`. */
      findings: LiveSummaryEntityDto[];
      groundedness?: LiveSummaryGroundednessDto;
      template: ResolvedDocumentTemplate;
      generation: number;
      /**
       * TASK-891 B5 — PHI-safe reason this flush's realtime lane did not produce a note.
       * Only consulted when there are NO sections to write; a flush that produced content
       * publishes content, whatever else degraded alongside it.
       */
      degradeReason?: string;
    },
  ): Promise<void> {
    if (ctx.sections.length === 0) {
      await this.publishSectionDegrade(session, ctx.template, ctx.degradeReason);
      return;
    }

    // The document this lane is producing. One document today; the key is what
    // makes a second one addressable without reshaping anything.
    const documentKey = ctx.template.slug;
    const sectionKeys = ctx.template.compiled.sectionKeys;
    const perSection = reanchorAnnotations(ctx.sections, ctx.runningSummary, ctx.entities, ctx.groundedness, ctx.findings);

    for (const [idx, section] of ctx.sections.entries()) {
      // Positional: `parseDocumentJson`/`parseDocumentSections` emit sections in
      // the compiled template's authored order, which IS `sectionKeys`' order.
      const sectionKey = sectionKeys[idx] ?? section.title.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      try {
        const result = await this.sections().applyFlushPatch({
          consultationId: session.consultationId,
          tenantId: session.tenantId,
          documentKey,
          sectionKey,
          title: section.title,
          idx,
          content: section.content,
          annotations: perSection[idx],
          documentTemplateVersionId: ctx.template.documentTemplateVersionId,
          generation: ctx.generation,
          userId: session.userId ?? null,
        });

        if (result.applied === true) {
          await this.safeChannelPublish(this.channel(session.consultationId), JSON.stringify(result.patch));
        } else if (result.reason !== 'unavailable') {
          // PHI-safe: the refusal REASON, never the content that was refused.
          this.logger.log({
            message: 'Section patch refused',
            consultationId: session.consultationId,
            documentKey,
            sectionKey,
            reason: result.reason,
          });
        }
      } catch (error) {
        this.logger.warn({
          message: 'Section patch failed (non-fatal — the whole-document payload already published)',
          consultationId: session.consultationId,
          sectionKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * TASK-891 B5 — tell the console that a flush FAILED, rather than leaving it to infer.
   *
   * ## The defect
   *
   * `case-note-column.tsx:120` renders `state === 'empty'` as a `<Skeleton />` — correctly,
   * because an unpopulated section of an in-progress note IS normal. But a node that failed
   * publishes NOTHING at all (this method's caller used to `return` on an empty section
   * list), so "still generating" and "generation failed" were the same pixels forever. The
   * owner watched that skeleton for ten minutes.
   *
   * ## What this publishes, and what it deliberately does not
   *
   * A transient `section.patch` per compiled section carrying `state: 'empty'`,
   * `revision: 0` and the reason. It writes NO row, takes NO version and touches the store's
   * staleness watermark not at all, so the CONFIRMED-is-never-overwritten-by-a-flush rule is
   * untouched — there is no write for it to govern. `revision: 0` is the second guard: the
   * DTO's mandatory "discard a patch whose revision is not greater than the one you hold"
   * rule makes this patch inert for any section a client already has content for, and
   * meaningful for exactly the sections that have never been written — which are the ones
   * showing the skeleton.
   *
   * Silent when nothing degraded: an empty section list with no reason is a flush that
   * legitimately had nothing to say (an empty transcript, a skipped node), not a failure.
   */
  private async publishSectionDegrade(session: LiveSession, template: ResolvedDocumentTemplate, degradeReason?: string): Promise<void> {
    if (!degradeReason) return;

    const titles = new Map(template.compiled.checklist.map((entry) => [entry.key, entry.title]));
    const updatedAt = new Date().toISOString();

    for (const [idx, sectionKey] of template.compiled.sectionKeys.entries()) {
      const patch: SectionPatchDto = {
        event: 'section.patch',
        consultationId: session.consultationId,
        documentKey: template.slug,
        sectionKey,
        title: titles.get(sectionKey) ?? sectionKey,
        idx,
        revision: 0,
        state: 'empty',
        content: '',
        documentTemplateVersionId: template.documentTemplateVersionId ?? null,
        degradeReason,
        updatedAt,
      };
      await this.safeChannelPublish(this.channel(session.consultationId), JSON.stringify(patch));
    }
  }

  /**
   * Overlay the session's frozen tool plan onto the PLATFORM lane.
   *
   * `ner`/`vitals` disabled ⇒ the extraction node is skipped, which is exactly
   * what the earlier flush did with the same plan. Without this, turning the
   * graph executor on would quietly re-enable a tool the tenant had turned off —
   * a behaviour change disguised as an engine change.
   */
  private applyToolPlanToPlatformLane(lane: RealtimeLane, agent: FrozenLiveAgentSnapshot): RealtimeLane {
    const extractionEnabled = this.toolRegistry.isEnabled(agent.toolPlan, 'ner') || this.toolRegistry.isEnabled(agent.toolPlan, 'vitals');
    if (extractionEnabled) return lane;
    return {
      ...lane,
      stages: lane.stages.map((stage) => ({
        ...stage,
        nodes: stage.nodes.map((node) => (node.type === 'consultation.extractEntities' ? { ...node, enabled: false } : node)),
      })),
    };
  }

  /**
   * Publish the lane's degrade events on the session's CONTROL channel.
   *
   * The control channel rather than the live-summary channel on purpose: these
   * are statements about the ENGINE, not about the note, and folding them into
   * the note payload would make a consumer that ignores them look like a consumer
   * that saw a healthy flush.
   */
  private async publishDegradeEvents(session: LiveSession, run: RealtimeRunResult): Promise<void> {
    for (const event of run.events) {
      // PHI-safe: node identity, status and a reason CODE — never clinical text.
      this.logger.warn({ message: 'Realtime lane node degraded', consultationId: session.consultationId, ...event });
    }
    await this.safeChannelPublish(
      this.controlChannel(session.consultationId),
      JSON.stringify({ type: 'lane.degraded', consultationId: session.consultationId, events: run.events, at: new Date().toISOString() }),
    );
  }

  /**
   * Record the ordered trajectory for one flush:
   *   [LLM_CALL:flush, TOOL_CALL:nlp.classify-tokens (when NLP ran),
   *    GUARDRAIL:groundedness (when the gate ran), PHASE:publish].
   * sessionKind=LIVE_DOC, runId="" (non-Temporal sentinel), consultationId set,
   * seq monotonic within the session. Fire-and-forget: wrapped in try/catch so a
   * telemetry failure can never break the live flush the clinician depends on.
   */
  private async recordFlushTrajectory(
    session: LiveSession,
    ctx: {
      textStats: LiveSummaryStatsDto | null;
      textFailed: boolean;
      textLatencyMs: number;
      /** whether the bounded JSON auto-repair retry ran. */
      textRepaired: boolean;
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

      // 1) LLM_CALL — the TEXT running-summary generation for this flush.
      steps.push({
        ...common,
        seq: session.trajectorySeq++,
        stepType: AgentStepType.LLM_CALL,
        name: 'flush',
        status: ctx.textFailed ? AgentStepStatus.ERROR : AgentStepStatus.OK,
        startedAt: new Date(now - ctx.textLatencyMs),
        endedAt: new Date(now),
        durationMs: ctx.textLatencyMs,
        stats: (ctx.textStats ?? undefined) as CreateAgentTrajectoryStepInput['stats'],
        // WHICH agent/prompt version produced this flush (additive).
        ...(session.agentSnapshot
          ? {
              payloadRef: {
                agentId: session.agentSnapshot.agentId,
                promptTemplateId: session.agentSnapshot.promptTemplateId,
                promptVersionNumber: session.agentSnapshot.promptVersionNumber,
                resolvedFrom: session.agentSnapshot.resolvedFrom,
              },
            }
          : {}),
      });

      // 1b) LLM_CALL — the bounded JSON auto-repair retry,
      // recorded only when the corrective retry actually ran so the trajectory
      // reflects EXACTLY the TEXT calls this flush made (original + at most one repair).
      if (ctx.textRepaired) {
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
    return sseFromRedisChannel(this.redisSubscriber, this.logger, {
      channel: this.channel(consultationId),
      heartbeatMs: this.heartbeatMs,
      loadSnapshot: () => this.cacheService.get(this.snapshotKey(consultationId)),
      isDuplicateOfSnapshot: (raw, snapshot) => this.isDuplicateOfLiveSummarySnapshot(raw, this.parseLiveSummaryUpdatedAt(snapshot)),
      isTerminal: closedFlagTerminal,
      setupErrorPayload: JSON.stringify({ error: 'Failed to subscribe to live summary', consultationId }),
      logContext: { consultationId },
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
          // The result stream now also carries non-transcript status frames
          // (provider_switched); narrow to transcripts before reading
          // transcript-only fields.
          if (msg?.type === 'transcript' && msg.isFinal && msg.text?.trim()) {
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
   * instead of overwriting its lock — that stops the duplicate TEXT spend and the
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
      this.logger.warn({
        message: 'Failed to subscribe to live-doc control channel',
        consultationId: session.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
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
        return;
      }
      // The frozen-agent pin rides the SAME renewal as the ownership
      // it belongs to, so a long consultation's snapshot can never expire out
      // from under a session that is still being served (risk R3).
      await this.refreshAgentSnapshotTtl(consultationId);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to renew live-doc owner lock',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Extend the frozen-agent key's TTL alongside the fenced owner-lock renewal. */
  private async refreshAgentSnapshotTtl(consultationId: string): Promise<void> {
    try {
      await this.cacheService.expire(this.agentKey(consultationId), this.LOCK_TTL);
    } catch {
      // Non-fatal: the in-memory freeze is authoritative for THIS instance; only
      // cross-instance adoption would degrade (to an identical version-pinned resolve).
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
    //  — WHICH document this snapshot is. `ContextItemType.PRE_SUMMARY`
    // is overloaded (D-22): the context-derived pre-summary and this running-note
    // snapshot are the same enum member, and with more than one document per
    // consultation that ambiguity becomes unresolvable. The key is the session's
    // frozen template slug; null (every earlier row, and a session whose
    // template never resolved) keeps its exact legacy meaning.
    const documentKey = session.templateSnapshot?.slug ?? null;
    if (!opts.force && (this.durableSnapshotMs <= 0 || Date.now() - session.lastDurableAt < this.durableSnapshotMs)) return;

    const content = payload.runningSummary?.trim();
    if (!content) return;

    session.lastDurableAt = Date.now();
    // The `agent` block is the LINEAGE HAND-OFF to finalize
    // (Lane C5 reads it off this exact row and stamps `SummaryMeta`). It carries
    // the version PIN, never the prompt bytes, and it is ADDITIVE: `subType`,
    // `lastSegmentId` and `updatedAt` keep their meaning and position, so the
    // existing readers (`findLiveSnapshotRow`, the harness warm-start reader)
    // are untouched. Present only once the session's agent has been frozen.
    const metaData = {
      subType: 'LIVE_SOAP_SNAPSHOT',
      lastSegmentId: session.lastSegmentId,
      updatedAt: payload.updatedAt,
      ...(session.agentSnapshot ? { agent: this.agentLineage(session.agentSnapshot) } : {}),
    };

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
          if (documentKey) existing.documentKey = documentKey;
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
          if (documentKey) entity.documentKey = documentKey;
          await this.encryptSnapshotContent(entity);
          await this.contextItemRepository.create(entity);
          session.snapshotEntity = entity;
          session.snapshotId = entity.id;
          this.logger.log({ message: 'Created live SOAP durable snapshot', consultationId: session.consultationId, contextItemId: entity.id });
        }
      } else {
        session.snapshotEntity.content = content;
        session.snapshotEntity.metaData = metaData;
        if (documentKey) session.snapshotEntity.documentKey = documentKey;
        await this.encryptSnapshotContent(session.snapshotEntity);
        await this.contextItemRepository.update(session.snapshotEntity.id, session.snapshotEntity);
      }
    } catch (error) {
      this.logger.warn({
        message: 'Failed to persist live SOAP durable snapshot',
        consultationId: session.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The newest LIVE_SOAP_SNAPSHOT row for a consultation, or null (review I-1).
   * `findLatestPreSummary` returns the newest PRE_SUMMARY of ANY subType, so it can
   * hand back a legacy/case-note pre-summary minted after our snapshot — which would
   * make the durable dedup mint a duplicate live row. Filter on the subType and take
   * the newest.
   *
   * Delegates to the shared repository helper
   * (`ContextItemRepository.findLatestPreSummaryWithDecryptedContent`) instead of
   * hand-rolling the find + subType-filter + newest-wins reduce here — this was one
   * of several copies of that exact logic (harness's `loadLiveSoapSnapshot`,
   * `SummaryService.resolveWarmStartPreSummary` and, before deleted
   * it, the legacy async summary generator's own copy). No
   * `secrets` is passed: this caller only ever reads `.metaData` off the row (agent
   * lineage / dedup identity), never `.content`, so there is nothing to decrypt and
   * no behaviour change from skipping it.
   */
  private async findLiveSnapshotRow(consultationId: string): Promise<ContextItemEntity | null> {
    if (!this.contextItemRepository) return null;
    const { entity } = await this.contextItemRepository.findLatestPreSummaryWithDecryptedContent(consultationId, undefined, {
      subType: 'LIVE_SOAP_SNAPSHOT',
    });
    return entity;
  }

  /**
   * Assemble the live TEXT user prompt. Once a note exists we
   * send it plus only the new transcript delta ("update the note") instead of the
   * whole transcript, keeping prompt size bounded; the first flush sends the delta
   * as the initial transcript.
   */
  /**
   * The stable lead-in for one flush: WHO the model is (governed, tenant-owned)
   * plus WHAT it must emit (compiled, platform-owned).
   *
   * These two are separable and only one of them is negotiable. A tenant's
   * governed prompt legitimately owns role, tone and clinical emphasis. It must
   * NOT be able to describe a different document than the strict schema the
   * response is decoded against — a model told in prose to write a SOAP note
   * while being constrained to a discharge summary has been given two
   * incompatible jobs, and which one wins depends on the provider. So the
   * structural instruction is always the SESSION TEMPLATE's, appended when the
   * governed prompt does not already carry it verbatim (the seeded SYSTEM
   * default does, which is why the common path appends nothing and the prompt
   * bytes are unchanged).
   *
   * On the `code-default` tier there is no governed prompt at all, so the whole
   * prefix is derived from the session's template — that tier previously served
   * the four SOAP headings unconditionally, which is precisely what made a
   * tenant's own shape unreachable.
   */
  private stablePrefixFor(agent: FrozenLiveAgentSnapshot, template: ResolvedDocumentTemplate): string {
    if (agent.resolvedFrom === 'code-default') {
      return buildStableUserPrefix(template.compiled);
    }
    return agent.stableUserPrefix.includes(template.compiled.promptInstruction)
      ? agent.stableUserPrefix
      : `${agent.stableUserPrefix}\n\n${template.compiled.promptInstruction}`;
  }

  /**
   * TASK-932 §3.7 — the OPERATING FRAME: the four steps a partial-summary turn actually performs.
   *
   * ## Why this is not in the department body
   *
   * The v3 department corpus is the CLINICAL instruction — what belongs under which heading,
   * which source may supply it, how a date is written. It is the customer's signed-off content
   * and this ticket does not touch a byte of it. What it does not say, because it predates the
   * realtime lane, is how a TURN works: that the transcript arriving is partial and possibly
   * code-switched, that a running note already exists and must be extended rather than restarted,
   * and that the output language is a separate axis from the transcript's.
   *
   * Every one of those is a property of the RUNTIME, identical for all 22 department bodies, so
   * stating it once here is what keeps it out of 22 prompts that would then drift.
   *
   * ## The steps, and why each is stated
   *
   *  1. TRANSLATE INTERNALLY. Malayalam-English code-switching is the default STT posture
   *     (`ASR_PARAMETERS.decoding.languageMode: 'ml-en'`, code-switching on), so a turn routinely
   *     arrives mixed. Left unsaid, the model mirrors whatever language dominates the last few
   *     seconds and the note changes language mid-consultation.
   *  2. MERGE, don't restart. The prior note is already in the prompt (`Current <title> so far`),
   *     but "here is your previous output" is not an instruction to preserve it.
   *  3. WRITE IN the declared language — omitted entirely when none was declared, because
   *     undeclared is not English (TASK-891 OD-1's posture, applied to the output axis).
   *  4. FILL the resolved template's sections, BY KEY. The section list is the compiled
   *     template's own, so a department shape and its prompt cannot disagree.
   */
  private operatingFrame(template: ResolvedDocumentTemplate, summaryLanguage: string | null | undefined): string {
    const sectionKeys = template.compiled.sectionKeys;
    const languageName = summaryLanguageName(summaryLanguage);
    const languageStep = languageName
      ? `Write every section value in ${languageName}${languageName === summaryLanguage ? '' : ` (${summaryLanguage})`}, whatever language was spoken. Keep the section keys and headings exactly as given, in English.`
      : 'No output language was declared for this consultation: follow the clinical instruction above, and do not switch language part-way through the note.';

    return [
      '',
      '',
      'HOW TO PRODUCE THIS TURN:',
      "1. The transcript is PARTIAL and may be code-switched or not in English. Read it in whatever language it is in and understand it in English internally; never transcribe another language's words into the note untranslated.",
      '2. This is an UPDATE, not a fresh note. Keep everything the running note above already records, extend a section the new transcript adds to, and revise one only where the new transcript contradicts it.',
      `3. ${languageStep}`,
      `4. Fill the sections of this document and no others, using these keys exactly: ${sectionKeys.join(', ')}. A section the consultation has not reached is null — never a placeholder, never invented content.`,
      '5. The consultation is still in progress. Write no closing summary, no sign-off and no statement that the encounter has ended.',
    ].join('\n');
  }

  private buildTextUserPrompt(
    priorNote: string,
    delta: string,
    notes: string,
    elided = false,
    stablePrefix: string = LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX,
    // the resolved template's own title. The three blocks below used
    // to say "SOAP note" in prose while the response schema described whatever
    // the tenant actually published; a model told to update a SOAP note and
    // decoded against a discharge summary is being given two different jobs.
    documentTitle: string = PLATFORM_TEMPLATE.compiled.title,
    // TASK-932 §3.7 — the operating frame, already rendered. Passed in rather than built here so
    // this method stays a pure string assembly and the frame is testable on its own.
    operatingFrame = '',
  ): string {
    const notesBlock = notes ? `\n\nClinician notes / labs:\n${notes}` : '';
    const hasPriorNote = priorNote.trim().length > 0;
    // In windowed mode an over-cap backlog drops its oldest part.
    // Say so: a partial window presented as the whole encounter would invite the
    // model to treat absent findings as absent from the visit. Appended AFTER the
    // stable prefix, and only when something was actually elided, so both the
    // prefix-cache-stable lead-in and the `whole`-mode prompt stay untouched.
    const elisionBlock = elided
      ? `\n\nNOTE: earlier transcript from this update was elided to fit the context window; the ${documentTitle} above already reflects it. Do not treat its absence as new information.`
      : '';

    // prefix-cache-friendly ordering:
    //   [stable system] + [transcript-so-far] + [current note] + [delta instruction]
    // The leading stable-system block is identical across the first flush and
    // every update flush (see LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX), so the engine
    // reuses the cached KV of that prefix. The mode-specific directive that
    // used to LEAD the prompt (breaking the shared prefix between first/update
    // flushes) is now the trailing block.
    const transcriptBlock = hasPriorNote ? `\n\nNew transcript since last update:\n${delta}` : `\n\nTranscript so far:\n${delta}`;
    const currentNoteBlock = hasPriorNote ? `\n\nCurrent ${documentTitle} so far:\n${priorNote}` : '';
    const deltaInstruction = hasPriorNote
      ? `\n\nUpdate the existing ${documentTitle} above using ONLY the new transcript since the last update; keep prior content unless it is contradicted.`
      : `\n\nFrom the transcript and any clinician notes/labs above, produce the running ${documentTitle} now.`;

    // The frame goes LAST, after the delta instruction: it is the turn's procedure, and a
    // trailing block is what the model reads immediately before generating. It is deliberately
    // NOT part of `stablePrefix` — the prefix is byte-identical across every flush of a session
    // so the engine can reuse its cached KV, and the frame carries the same bytes for the same
    // session, so appending it here costs the cache nothing while keeping the prefix's contract
    // (tenant-governed prose + compiled structure) unmuddied.
    return stablePrefix + transcriptBlock + currentNoteBlock + elisionBlock + deltaInstruction + notesBlock + operatingFrame;
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
   * and a knob a super admin can see in the catalog must be the knob that governs.
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

  /**
   * TASK-891 B1 — resolve the EFFECTIVE realtime TEXT budget for this flush and cache it
   * on the instance for the three HTTP hops that read it (`postTextGenerate`,
   * `proposeCorrections`, `extractImportantFindings`), all of which run inside the flush
   * that resolved it.
   *
   * Precedence, matching the `agentic.context.*` siblings: STORED VALUE → env override →
   * descriptor code default. Env deliberately LOSES to a stored value, because the
   * registry is the control plane and a budget that needs a redeploy to move is the
   * defect this key exists to fix.
   *
   * Never throws: a settings-backend failure keeps the env/default budget for this flush
   * rather than failing the note the clinician is waiting for.
   */
  private async resolveTextTimeoutMs(tenantId: string): Promise<number> {
    const fallback = this.envTextTimeoutMs ?? CONSULTATION_REALTIME_DEFAULTS[CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY];
    if (!this.effectiveSettings) {
      this.textTimeoutMs = fallback;
      return fallback;
    }
    try {
      const resolved = await this.effectiveSettings.resolveEffective(CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY, { tenantId });
      this.textTimeoutMs = storedNumber(resolved) ?? fallback;
    } catch (error) {
      this.logger.warn({
        message: 'consultation.realtime.textTimeoutMs resolution failed — keeping the env/code default for this flush',
        error: error instanceof Error ? error.message : String(error),
      });
      this.textTimeoutMs = fallback;
    }
    return this.textTimeoutMs;
  }

  /**
   * TASK-932 D-4 - the groundedness gate for THIS flush.
   *
   * `liveDoc.groundedness.enabled` moved from `LIVE_DOC_GROUNDEDNESS_ENABLED`
   * (read once in the constructor, so enabling it needed a restart and could
   * never be scoped to a tenant) to the `global-kv` cascade. Same shape and same
   * failure posture as {@link resolveTextTimeoutMs}: a stored row wins, an
   * unresolvable read keeps the previous answer for this flush rather than
   * flipping a clinical gate on a transient control-plane blip.
   *
   * Writing through `toolEnvDefaults` (held by identity) is what makes the new
   * value visible to `LiveToolRegistry.isEnabled` — a session's frozen tool plan
   * still wins, exactly as before; this only moves the `enabled: null` default.
   */
  private async resolveGroundednessEnabled(tenantId: string): Promise<boolean> {
    const fallback = this.envGroundednessEnabled ?? false;
    if (!this.effectiveSettings) {
      this.groundednessEnabled = fallback;
      this.toolEnvDefaults.groundedness = fallback;
      return fallback;
    }
    try {
      const resolved = await this.effectiveSettings.resolveEffective(LIVE_DOC_GROUNDEDNESS_ENABLED_KEY, { tenantId });
      this.groundednessEnabled = resolved.sourceScope === 'code-default' ? fallback : resolved.value === true;
    } catch (error) {
      this.logger.warn({
        message: 'liveDoc.groundedness.enabled resolution failed — keeping the previous answer for this flush',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.toolEnvDefaults.groundedness = this.groundednessEnabled;
    return this.groundednessEnabled;
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

  /**
   * TASK-930 (G-1) — `RealtimeCapabilities.resolveAgent`: a slug-form `core.agent` reference to
   * the agent's TASK, so the lane dispatches on what the agent IS.
   *
   * Until this ticket the hook was unimplemented, so `CoreAgentHandler` fell back to
   * `TEXT_GENERATION` for every slug-form reference and the seeded graphs' ASR and NER nodes each
   * GENERATED A NOTE instead of transcribing / extracting. Nothing errored — the lane simply did
   * the wrong work, three times per flush.
   *
   * FAIL CLOSED, exactly as `resolveRealtimeTextAgent` does, and for the same reason: an unknown,
   * unpublished or cross-tenant slug is one 404 out of `AgentResolverService` (404-over-403) and a
   * version pin that no longer matches the active published version is a 409. Both THROW, and the
   * executor turns the throw into a named degrade — nothing is generated in the node's place.
   *
   * Two references resolve to `null` rather than throwing, and the difference from the paragraph
   * above is deliberate. A TASK-form reference is the code-built platform lane naming the tenant's
   * ASSIGNED agent for a task, which the handler already dispatches on directly. And a composition
   * with no resolver at all cannot ANSWER the question, so it keeps the hook's declared
   * absent-means-fallback semantics: that is a wiring state, not a tenant's agent gone missing, and
   * turning it into a per-node degrade would take out every lane in a stack that predates this
   * ticket. Production always wires it (`LiveDocumentationServiceModule` imports
   * `AgentServiceModule`), so the fail-closed branches below are the ones that run.
   */
  private async resolveRealtimeAgentView(ref: RealtimeAgentRef, tenantId: string): Promise<RealtimeResolvedAgentView | null> {
    const { slug, versionNumber } = ref as { slug?: string; versionNumber?: number };
    if (slug === undefined || !this.agentResolver) return null;
    const resolved = await this.agentResolver.resolve({ tenantId, agentSlug: slug });
    // The resolver serves the ACTIVE published version and takes no pin, so honouring one means
    // REFUSING a different version — a pin that ran whatever is active would be no pin at all.
    if (versionNumber !== undefined && resolved.versionNumber !== versionNumber) {
      throw new ConflictException({
        code: 'AGENT_VERSION_DRIFT',
        message: `Agent '${resolved.slug}' is pinned to v${versionNumber} but the active published version is v${resolved.versionNumber}.`,
      });
    }
    // `ResolvedAgent.task` and `RealtimeAgentTask` are the SAME four literals, declared twice so
    // the lane needs no enum from the agent plane. Assigned directly rather than mapped: a fifth
    // task added to one and not the other must surface here as a compile error.
    return {
      slug: resolved.slug,
      task: resolved.task,
      outputSchema: resolved.compiledConfig?.outputSchema,
      parameters: resolved.compiledConfig?.parameters ?? null,
    };
  }

  /**
   * slug → task for every slug-form `core.agent` of a lane, resolved ONCE for the read-out.
   *
   * The read-out DESCRIBES; it never fails. An unresolvable slug is simply absent from the map,
   * which makes `realtimeCapabilityOf` report the same `generateDocument` the handler would fall
   * back to — describing a lane that does not exist would be the worse answer.
   */
  private async resolveLaneAgentTasks(lane: RealtimeLane, tenantId: string): Promise<Map<string, RealtimeAgentTask>> {
    const tasks = new Map<string, RealtimeAgentTask>();
    if (!this.agentResolver) return tasks;
    const slugs = new Set<string>();
    for (const stage of lane.stages) {
      for (const node of stage.nodes) {
        const slug = readAgentRef(node.config)?.slug;
        if (slug !== undefined) slugs.add(slug);
      }
    }
    for (const slug of slugs) {
      try {
        const view = await this.resolveRealtimeAgentView({ slug }, tenantId);
        if (view) tasks.set(slug, view.task);
      } catch (error) {
        this.logger.debug({
          message: 'Realtime capability read-out could not resolve a referenced agent — reporting the handler’s own fallback',
          tenantId,
          agentSlug: slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return tasks;
  }

  /** TASK-876 — the bound agent for a realtime `core.agent` node, or a throw the executor turns into a named degrade. */
  private async resolveRealtimeAgent(agentRef: { slug: string; versionNumber?: number }, tenantId: string): Promise<ResolvedTextGenerationSpec> {
    if (!this.textAgents) {
      throw new Error(
        `core.agent: agent '${agentRef.slug}' cannot be resolved — the TEXT_GENERATION agent resolver is not wired in this composition`,
      );
    }
    return this.textAgents.resolve({
      tenantId,
      agentSlug: agentRef.slug,
      ...(agentRef.versionNumber !== undefined ? { versionNumber: agentRef.versionNumber } : {}),
    });
  }

  /**
   * TASK-890 §3.14 — resolve a realtime `core.agent` node's agent AND fold its guardrail decision.
   *
   * The fold happens HERE, once per call, because this is the only place all three opinions are
   * in scope: the node's own `config.guardrail` (authored on the graph), the WORKFLOW default the
   * compiler froze onto `policyBindings.guardrail` (carried by the lane), and the agent's own
   * `compiledConfig.guardrail` the resolver normalised. Precedence is the shared
   * `resolveGuardrailDecision` — node > workflow > agent > ON — so this lane and the durable lane
   * (`guardrail_optout.resolve_guardrail_decision`) answer identically for the same node.
   *
   * A legacy summary node carries no `agentRef` and keeps the assigned-agent path inside
   * `callText`, which expresses no opinion and lets TEXT's platform posture govern — unchanged.
   */
  private async resolveRealtimeTextAgent(
    input: { agentRef?: RealtimeAgentRef; config?: Readonly<Record<string, unknown>> },
    tenantId: string,
    lane: RealtimeLane,
  ): Promise<{ spec: ResolvedTextGenerationSpec; overrides: NodeOverrides; guardrail: { enabled: boolean } } | undefined> {
    // TASK-893 — a `core.agent` names its agent by SLUG or by TASK. Only the slug form pins an
    // agent; the task form is the code-built platform lane saying "the tenant's assigned
    // TEXT_GENERATION agent", which is exactly the `undefined` path `callText` already takes
    // through `resolveTextSelection`. Resolving it here would hard-code a slug the assignment
    // cascade owns.
    const { slug, versionNumber } = (input.agentRef ?? {}) as { slug?: string; versionNumber?: number };
    if (slug === undefined) return undefined;
    const spec = await this.resolveRealtimeAgent({ slug, ...(versionNumber !== undefined ? { versionNumber } : {}) }, tenantId);
    const guardrail = resolveGuardrailDecision({
      node: guardrailOptOutOf(input.config),
      workflow: lane.guardrail,
      // Optional-chained on purpose: `ResolvedAgent.guardrail` is non-optional by type, but a
      // resolver answer built before this ticket (or a fixture) can carry none, and a MISSING
      // opinion must read as INHERIT (`null`) — which the fold then resolves to ON. On a safety
      // gate, "unreadable" must never resolve to an opt-out.
      agent: spec.agent?.guardrail?.enabled ?? null,
    });
    return { spec, overrides: nodeOverrides(input.config), guardrail: { enabled: guardrail.enabled } };
  }

  private async callText(
    promptText: string,
    tenantId: string,
    signal?: AbortSignal,
    corrective?: string,
    agent?: FrozenLiveAgentSnapshot,
    // the session's FROZEN compiled template. Defaulted to the
    // platform shape so non-DI/positional test fixtures keep their arity.
    compiled: CompiledDocumentTemplate = PLATFORM_TEMPLATE.compiled,
    // TASK-876 — a `core.agent` node's RESOLVED agent (primary + ordered fallback chain) and the
    // node's own `overrides`. Trailing and optional, so every legacy-flush caller keeps its
    // arity and generates on the tenant's ASSIGNED agent instead.
    textAgent?: { spec: ResolvedTextGenerationSpec; overrides: NodeOverrides; guardrail?: { enabled: boolean } },
    // TASK-890 §3.13 — attribution for the usage row this call now records. Trailing and
    // optional so every positional fixture keeps its arity.
    consultationId?: string | null,
  ): Promise<{ text: string; stats: LiveSummaryStatsDto | null; structured: boolean }> {
    if (textAgent) {
      // The candidates this call may run, in order: the primary, then — only when the tenant's
      // per-agent HA toggle is ON (owner decision #4, default ON) — the resolved chain: the
      // explicit fallback agent or the agent's own model chain, then the SYSTEM platform default.
      const candidates = [textAgent.spec.primary, ...(textAgent.spec.fallback.autoSwitch ? textAgent.spec.fallback.chain : [])];
      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          return await this.callTextCandidate(
            promptText,
            tenantId,
            candidate,
            textAgent.overrides,
            compiled,
            signal,
            corrective,
            consultationId,
            textAgent.guardrail,
          );
        } catch (error) {
          lastError = error;
          // TASK-890 §3.2 — a prompt that does not render is not a provider outage either: every
          // candidate would fail identically, so the node degrades here with the path named.
          if (error instanceof LivePromptUnresolvedError) throw error;
          // An aborted flush is not a provider outage — nothing to switch to.
          if (signal?.aborted || candidate === candidates[candidates.length - 1]) break;
          this.logger.warn({
            message: 'Live TEXT call failed on the bound agent — switching to the next resolved fallback (autoSwitch on)',
            tenantId,
            agentSlug: candidate.agent.slug,
            kind: candidate.kind,
            provider: candidate.provider,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      throw lastError;
    }

    // TEXT is a stateless gateway with no model default. Since TASK-876 the tenant's ASSIGNED
    // TEXT_GENERATION agent (`department → tenant → SYSTEM`) selects the model, through the ONE
    // fail-closed seam every TS text caller shares (`resolveTextSelection`).
    //
    // TASK-891 — `live` is a SELECTOR again, not merely the `task_key` telemetry this comment
    // used to claim: it rides the cascade as the reserved `phase:live` assignment tag, so a
    // tenant can assign a distinct live-tier agent beside its finalize one. That is the whole
    // point of the split — one agent holds one reasoning posture, and the realtime note needs
    // the opposite of what the finalize synthesis wants.
    //
    // `generation` is that agent's authored `parameters.generation`, carried out of the seam so
    // its reasoning posture can ride the `extra` ride-along below. Without it the live agent was
    // selected and inert. Only the posture is read here: the token budget stays this lane's own
    // (`this.textMaxTokens`), as it was before the split.
    // Fall back to env only when the resolver is not wired (kept for non-DI construction paths).
    let provider = this.textProvider;
    let model = this.textModel;
    let generation: unknown;
    if (this.harnessPolicyService) {
      ({ provider, model, generation } = await this.harnessPolicyService.resolveTextSelection(tenantId, 'live'));
    }
    // `response_format: json_schema` makes json-schema-capable providers return a
    // deterministic sectioned object (parsed by parseDocumentJson); ollama ignores it so we
    // omit it there and fall back to the prose regex parse (P0-C).
    const includeResponseFormat = (provider ?? '').toLowerCase() !== 'ollama';
    // the bounded auto-repair retry appends the corrective
    // instruction AFTER the stable prompt so the prefix-cache-friendly lead-in
    // (Phase 4D.1) stays byte-identical between the original and repair calls.
    const payload = {
      prompt: corrective ? `${promptText}${corrective}` : promptText,
      // The frozen snapshot's system prompt; identical to the exported constant
      // whenever no agent binding customized it (the paired sha256 guards prove
      // the constant and the seeded SYSTEM default carry the same bytes).
      system_prompt: agent?.systemPrompt ?? LIVE_DOCUMENT_SYSTEM_PROMPT,
      provider,
      model,
      max_tokens: this.textMaxTokens,
      stream: false as const,
      // the strict schema COMPILED from the session's pinned template
      // shape, not a frozen literal. This is the whole of "the template IS the
      // schema": an optional section arrives here as a nullable property, so a
      // model that was never told about an examination can say so (D-21) instead
      // of being forbidden to emit anything but a string.
      response_format: includeResponseFormat ? compiled.responseFormat : undefined,
    };
    const stats = await this.postTextGenerate(payload, tenantId, signal, consultationId, undefined, generation);
    // Stamp WHICH routing task served this flush (`text.live`, never `text.finalize` — this
    // method is the live tier exclusively). TEXT itself has no notion of this key; it only
    // echoes back the provider/model it actually ran, so the tier provenance is stamped here.
    return {
      text: stats.text,
      // `selection_source` is additive telemetry: `assigned-agent` = the tenant's ASSIGNED
      // TEXT_GENERATION agent chose this model per flush (vs `agent` / `agent-fallback` for a
      // `core.agent` node that named its own). It read `task-default` until TASK-876, which was
      // the name of the retired `AiTaskDefault` tier and no longer describes anything.
      stats: stats.stats ? { ...stats.stats, task_key: 'text.live', selection_source: 'assigned-agent' } : null,
      structured: includeResponseFormat,
    };
  }

  /**
   * TASK-876 — ONE TEXT call on ONE resolved candidate of a bound agent: the candidate's
   * provider-native model, its resolved instruction interpolated with the agent's own
   * variables and the node's `overrides.promptVariables` (node wins), and its generation
   * hyper-parameters with the node's `overrides.generation` layered on top. The response
   * format stays the session's compiled DOCUMENT schema — on this lane the agent writes the
   * running note, so the document shape, not the agent's `responseFormat`, is the contract.
   */
  private async callTextCandidate(
    promptText: string,
    tenantId: string,
    candidate: ResolvedTextCandidate,
    overrides: NodeOverrides,
    compiled: CompiledDocumentTemplate,
    signal?: AbortSignal,
    corrective?: string,
    consultationId?: string | null,
    // TASK-890 §3.14 — the FOLDED guardrail decision for this node (node > workflow > agent > on),
    // computed once by `resolveRealtimeTextAgent`. Every candidate of one node carries the same
    // decision: switching engines on an outage must never change whether the call is screened.
    guardrail?: { enabled: boolean },
  ): Promise<{ text: string; stats: LiveSummaryStatsDto | null; structured: boolean }> {
    const includeResponseFormat = candidate.provider.toLowerCase() !== 'ollama';
    const generation = { ...asRecord(candidate.parameters.generation), ...overrides.generation };
    const instruction = asRecord(candidate.instruction);
    const variables = { ...asRecord(instruction.variables), ...overrides.promptVariables };
    const promptTemplate = candidate.resolvedPrompt?.content ?? (typeof instruction.systemPrompt === 'string' ? instruction.systemPrompt : null);
    // TASK-876 — the RESOLVED candidate's own credential is authoritative for this request.
    // Without it `postTextGenerate`'s enrichment recomputes `provider_overrides` from the CLS
    // tenant, so a call served by the SYSTEM platform default would be forwarded with the
    // TENANT's key and metered `funding: 'tenant'` — the opposite of the tier that actually
    // served, and of `candidate.fundingTier` stamped on the stats one block below.
    const { provider: _overrideProvider, ...overrideEntry } = candidate.providerOverride ?? {};
    const payload = {
      prompt: corrective ? `${promptText}${corrective}` : promptText,
      system_prompt: promptTemplate ? renderLivePrompt(promptTemplate, variables, candidate.agent.slug) : LIVE_DOCUMENT_SYSTEM_PROMPT,
      provider: candidate.provider,
      model: candidate.model,
      temperature: numberOrUndefined(generation.temperature),
      max_tokens: numberOrUndefined(generation.maxTokens) ?? this.textMaxTokens,
      top_p: numberOrUndefined(generation.topP),
      stream: false as const,
      response_format: includeResponseFormat ? compiled.responseFormat : undefined,
      ...(candidate.providerOverride ? { provider_overrides: { [candidate.provider]: overrideEntry } } : {}),
    };
    // The decision goes on the wire EXPLICITLY in both directions, so TEXT can tell "screened by
    // this tenant's opinion" from "no opinion, platform posture governs".
    if (guardrail) this.textRequestEnrichment?.applyGuardrailDecision(payload, guardrail);
    // TASK-891 C2 — `generation` already carries the node's `overrides.generation` layered
    // over the agent's own, so the reasoning posture follows the same precedence every other
    // hyper-parameter on this call does.
    const result = await this.postTextGenerate(payload, tenantId, signal, consultationId, guardrail, generation);
    return {
      text: result.text,
      stats: result.stats
        ? {
            ...result.stats,
            task_key: 'text.live',
            selection_source: candidate.kind === 'primary' ? 'agent' : 'agent-fallback',
            agent_slug: candidate.agent.slug,
            funding_tier: candidate.fundingTier,
          }
        : null,
      structured: includeResponseFormat,
    };
  }

  /**
   * TASK-890 §3.13 — the LLM quota precheck every generation on this lane now makes.
   *
   * No increment: a generation's token count is unknowable before the model answers, so this is
   * the "is this tenant over its ceiling AT ALL" shape `summary.service.ts` documents. A 429
   * from here propagates — a consultation that has exhausted its plan must be told, not served
   * silently and billed later. Absent service ⇒ no gate, exactly as before.
   */
  private async assertLlmQuota(tenantId: string): Promise<void> {
    await this.entitlements?.assertMeterQuota(tenantId, 'monthlyLlmTokens');
  }

  /**
   * TASK-890 §3.13 — record ONE `generate` row for a completed TEXT call on this lane.
   *
   * `trigger: 'CONSULTATION'` is the dimension that separates this lane's spend from a prompt
   * bench's or a workflow run's. Best-effort by contract: the model already ran and the
   * clinician is waiting for the note, so a ledger outage is logged and swallowed — "not
   * metered" is recoverable from the provider's own usage API, a failed flush is not. TEXT
   * reporting no `usage_detail` records NOTHING rather than a row saying nothing happened.
   */
  private recordLlmUsage(tenantId: string, data: unknown, consultationId?: string | null, guardrail?: { enabled: boolean }): void {
    if (!this.usageLedger) return;
    const usage = parseTextUsageDetail((data as { usage_detail?: unknown } | null)?.usage_detail);
    if (!usage) return;
    const batch = withUsageTrigger(
      buildLlmUsageInput({ usage, tenantId, operation: 'generate', consultationId: consultationId ?? null }),
      'CONSULTATION',
    );
    if (!batch) return;
    const ledger = this.usageLedger;
    // TASK-890 §3.14 record (a) — a `core.agent` node stamps the DISPOSITION beside the trigger,
    // so "this consultation ran without its guard" is a query, not an inference from graph JSON.
    // The disposition read is async (it consults the PLATFORM kill switch, which outranks the
    // node's opinion), so it is folded inside the same fire-and-forget chain the row already
    // used. A legacy flush passes no decision and stamps no key, exactly as before.
    const record = async (): Promise<void> => {
      const stamped =
        guardrail && this.textRequestEnrichment
          ? withUsageAttributes(batch, { guardrail: await this.textRequestEnrichment.guardrailDisposition(guardrail) })
          : batch;
      if (!stamped) return;
      await ledger.recordUsage(stamped);
    };
    void record().catch((error: unknown) => {
      this.logger.warn({
        message: 'Live TEXT generation was not metered (the note was still produced)',
        tenantId,
        consultationId: consultationId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** The shared gateway→TEXT hop the two live generation paths make: enrichment, auth, tenant header, one POST. */
  private async postTextGenerate(
    payload: { provider?: string; model?: string; [key: string]: unknown },
    tenantId: string,
    signal?: AbortSignal,
    consultationId?: string | null,
    guardrail?: { enabled: boolean },
    // TASK-891 C2 — the RESOLVED agent's `parameters.generation`, when this hop is made on
    // behalf of one. Its `reasoning` block becomes the `extra` ride-along. Absent on the
    // non-agent paths, where there is no agent to have an opinion.
    generation?: unknown,
  ): Promise<{ text: string; stats: LiveSummaryStatsDto | null }> {
    // fold in the caller tenant's resolved provider credential
    // (`provider_overrides`) through the ONE shared implementation. Not
    // hand-rolled here: the resolver cascades tenant → SYSTEM and each entry's
    // `funding` label rides along, so TEXT meters platform-funded generation as
    // CLOUD rather than as this tenant's own BYOK. Fail-open by contract — a
    // resolver error injects nothing and the call proceeds, while a POLICY
    // refusal (tenant veto / missing entitlement) still throws so the outage is
    // attributable instead of surfacing as TEXT's unattributable 503.
    // layer the resolved agent's engine ride-alongs (TASK-891 C2: the reasoning posture of
    // `parameters.generation.reasoning`, sent as `extra.reasoning_effort` and forwarded by
    // TEXT as `extra_body`) BEFORE the credential fold, exactly as the TEXT proxy does.
    // Caller-set fields win; an agent with no opinion injects nothing.
    await this.textRequestEnrichment?.applyTextRuntimeProfile(payload, generation);
    await this.textRequestEnrichment?.applyTenantProviderOverrides(payload);
    // The gateway→TEXT hop is shared-secret authenticated (`X-Service-Token`).
    // This call omitted it, so wherever TEXT actually enforces a token — i.e.
    // every environment where the internal token is non-empty — the live loop
    // was rejected with `invalid_or_missing_token` and the flush degraded to an
    // empty note. It "worked" only in dev, where an empty token
    // trips TEXT's bypass. Same resolution the sibling TEXT callers use
    // (`prompt-management.service.ts`, `dna-writing-style.processor.ts`); `??
    // ''` preserves the dev bypass when no secret is configured.
    // D-D: the ONE shared `INTERNAL_ACCESS_TOKEN` (the per-service `TEXT_SERVICE_TOKEN`
    // fallback was retired with its descriptor, TASK-888). `X-Tenant-Id` is MANDATORY — TEXT resolves the
    // tenant's BYOK provider/credential from it, and derives
    // `funding`/`cost_basis` from whichever tier supplied that credential, so a
    // dropped header mis-bills silently as well as mis-configuring the call. This is
    // the highest-volume internal hop in the platform (every live-doc flush).
    const serviceToken = await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN');
    // TASK-890 §3.13 — the ceiling is checked BEFORE the upstream call, the units are recorded
    // from the upstream's own `usage_detail` AFTER it.
    await this.assertLlmQuota(tenantId);
    const response = await this.httpService.axiosRef.post(`${this.textServiceUrl}/api/v1/generate`, payload, {
      timeout: this.textTimeoutMs,
      headers: internalServiceHeaders({ serviceToken, tenantId, tenantlessReason: TENANTLESS.PLATFORM_OPERATOR }),
      signal,
    });
    this.recordLlmUsage(tenantId, response.data, consultationId, guardrail);
    return { text: mapTextGenerateResponse(response.data).summary, stats: this.parseGenerationStats(response.data) };
  }

  /**
   * Lane R (R1) — PROPOSE spelling / medical-term / drug-name corrections over the RAW PARTIAL
   * transcript. Applies none of them.
   *
   * ## Why this exists in TypeScript when a Python engine already proposes corrections
   *
   * `interpreter.consultation_propose_corrections` is `lane: 'durable'` and, in both seeded
   * consultation graphs, is fed from `consultation.synthesize` — it reviews the FINISHED note at
   * the end of a run, not the transcript a clinician is watching grow. Lane membership is a
   * property of the node TYPE and the durable interpreter SKIPS realtime nodes, so one type
   * cannot serve both cadences.
   *
   * What is NOT duplicated is the ENGINE: `apps/text` is the engine, and this is a thin caller of
   * it exactly as `callText` is for the running note. What IS duplicated, deliberately, is the
   * VERIFICATION below — a proposal whose span does not match its own `original` must be dropped
   * at every producer, because accepting it in a one-click UI would splice a replacement over the
   * wrong characters. That is a patient-safety invariant, and defence in depth is the correct
   * treatment for one.
   *
   * The system prompt is NOT a literal here. It comes from the node's own `promptTemplateId`
   * binding, and an unbound / unapproved / unresolvable template THROWS so the executor degrades
   * the node with a named reason — a governed prompt that silently becomes an in-code default is
   * exactly the hardcoded-configuration failure `00-project-context.md` forbids.
   */
  private async proposeCorrections(
    input: { sourceText: string; entities: LiveSummaryEntityDto[]; tenantId: string; config: Readonly<Record<string, unknown>> },
    consultationId: string,
    signal?: AbortSignal,
  ): Promise<{ proposals: HarnessLiveAssistProposalDto[]; textSha256: string; rejectedProposals: number }> {
    const { sourceText, entities, tenantId, config } = input;
    const textSha256 = createHash('sha256').update(sourceText, 'utf8').digest('hex');

    const systemPrompt = await this.resolveCorrectionPrompt(config);

    // Same LIVE tier the running note uses, and fail-CLOSED the same way: provider/model
    // SELECTION is never substituted with an env default — the tenant's assigned
    // TEXT_GENERATION agent selects (TASK-876; the node `llmBinding` is retired).
    // TASK-891 — and the same agent's `generation`, so this hop obeys the reasoning posture the
    // running note obeys. It shares the flush's budget; a posture honoured on one of the three
    // live hops and ignored on the others buys back a fraction of the saving.
    let provider = this.textProvider;
    let model = this.textModel;
    let generation: unknown;
    if (this.harnessPolicyService) ({ provider, model, generation } = await this.harnessPolicyService.resolveTextSelection(tenantId, 'live'));

    const payload = {
      // The entity spans are DETECTOR HINTS: they tell the model where a clinical term was found
      // so it proposes over those spans rather than over ordinary prose.
      prompt: JSON.stringify({ text: sourceText, entities: entities.map((e) => ({ start: e.start, end: e.end, text: e.text, type: e.type })) }),
      system_prompt: systemPrompt,
      provider,
      model,
      max_tokens: this.textMaxTokens,
      stream: false as const,
    };
    // layer the SELECTED agent's engine ride-alongs (its reasoning posture, as
    // `extra.reasoning_effort`) BEFORE the credential fold, exactly as the TEXT proxy does.
    // Caller-set fields win; an agent with no opinion injects nothing.
    await this.textRequestEnrichment?.applyTextRuntimeProfile(payload as { provider?: string; model?: string }, generation);
    await this.textRequestEnrichment?.applyTenantProviderOverrides(payload as { provider?: string });
    const serviceToken = await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN');
    // TASK-890 §3.13 — the grammar pass is a generation like any other: gated and counted.
    await this.assertLlmQuota(tenantId);
    const response = await this.httpService.axiosRef.post(`${this.textServiceUrl}/api/v1/generate`, payload, {
      timeout: this.textTimeoutMs,
      headers: internalServiceHeaders({ serviceToken, tenantId, tenantlessReason: TENANTLESS.PLATFORM_OPERATOR }),
      signal,
    });
    this.recordLlmUsage(tenantId, response.data, consultationId);

    const { proposals, rejectedProposals } = verifyCorrectionProposals(mapTextGenerateResponse(response.data).summary, sourceText, {
      provider,
      model,
    });

    // Publish onto the EXISTING clinician-assist plane. Best-effort by contract, like every
    // sibling publish path: a feed outage must not fail the flush.
    if (this.liveAssist && proposals.length > 0) {
      await this.liveAssist.publishAssist(consultationId, {
        tenantId,
        kind: 'corrections',
        nodeType: 'agent.grammar',
        provider,
        model,
        corrections: { proposals, applied: false, appliedCount: 0, rejectedProposals, textSha256 },
      });
    }

    return { proposals, textSha256, rejectedProposals };
  }

  /**
   * Resolve the correction system prompt from the NODE's `promptTemplateId` binding.
   *
   * Throws rather than defaulting. The executor turns the throw into a `degraded` outcome with a
   * typed event, so an unconfigured grammar node is VISIBLE to the clinician UI instead of
   * looking like a model that found nothing to correct.
   */
  private async resolveCorrectionPrompt(config: Readonly<Record<string, unknown>>): Promise<string> {
    return this.resolveGovernedNodePrompt(config, 'correction');
  }

  /**
   * Lane N — mine IMPORTANT FINDINGS from the consultation context, by the TENANT'S instruction.
   *
   * ## There is no importance logic in this method, and that is the design
   *
   * asked the owner what makes information "important". The answer was not a
   * severity scale:
   *
   * > "'Important' information or findings will be mined/generated/extracted by agent following a
   * > set of instructions defined/declared/overwriten by tenant admin for using LLM to detect,
   * > extract, picking-up knowledge from consultation context (transcription, consultation context
   * > items, etc...)"
   *
   * So the system prompt is the node's bound `promptTemplateId`, resolved APPROVED, and an
   * unbound / unapproved / empty template THROWS so the executor degrades the node with a named
   * reason. It does not fall back to a default, and it must never grow one: a constant here would
   * be this service deciding what is clinically important for every tenant on the platform, which
   * is exactly the hardcoded configuration `00-project-context.md` §Configuration Principles
   * forbids — and a far worse instance of it than a mis-placed timeout.
   *
   * Nothing below inspects, ranks, filters or re-labels what comes back beyond dropping rows a
   * client could not anchor a highlight to. `type` is whatever label the tenant's instruction told
   * the model to assign.
   *
   * ## Selection is fail-CLOSED, exactly like the running note
   *
   * Provider/model resolve tenant -> SYSTEM through the same `resolveTextSelection(…, 'live')`
   * path `callText` uses; there is no env fallback.
   */
  private async extractImportantFindings(
    input: { sourceText: string; context: unknown[]; entities: LiveSummaryEntityDto[]; tenantId: string; config: Readonly<Record<string, unknown>> },
    signal?: AbortSignal,
  ): Promise<{ findings: LiveSummaryEntityDto[] }> {
    const { sourceText, context, entities, tenantId, config } = input;
    const systemPrompt = await this.resolveGovernedNodePrompt(config, 'findings');

    // same selection as the grammar pass: the tenant's assigned TEXT_GENERATION agent, and
    // (TASK-891) the `generation` block that agent authored, so this hop honours the same
    // reasoning posture as the other two on the flush.
    let provider = this.textProvider;
    let model = this.textModel;
    let generation: unknown;
    if (this.harnessPolicyService) ({ provider, model, generation } = await this.harnessPolicyService.resolveTextSelection(tenantId, 'live'));

    const payload = {
      // The context the owner's sentence names, handed over as authored. Entity spans ride along
      // as DETECTOR HINTS, the same "one call, two uses" the grammar pass makes.
      prompt: JSON.stringify({
        transcript: sourceText,
        ...(context.length > 0 ? { context } : {}),
        ...(entities.length > 0 ? { entities: entities.map((e) => ({ start: e.start, end: e.end, text: e.text, type: e.type })) } : {}),
      }),
      system_prompt: systemPrompt,
      provider,
      model,
      max_tokens: this.textMaxTokens,
      stream: false as const,
    };
    // layer the SELECTED agent's engine ride-alongs (its reasoning posture, as
    // `extra.reasoning_effort`) BEFORE the credential fold, exactly as the TEXT proxy does.
    // Caller-set fields win; an agent with no opinion injects nothing.
    await this.textRequestEnrichment?.applyTextRuntimeProfile(payload as { provider?: string; model?: string }, generation);
    await this.textRequestEnrichment?.applyTenantProviderOverrides(payload as { provider?: string });
    const serviceToken = await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN');
    // TASK-890 §3.13 — Lane N's mining call is a generation too. It carries no consultation id
    // (this method is not given one), so the row is attributed to the tenant alone; threading
    // the id here is a follow-up, not a reason to leave the call uncounted.
    await this.assertLlmQuota(tenantId);
    const response = await this.httpService.axiosRef.post(`${this.textServiceUrl}/api/v1/generate`, payload, {
      timeout: this.textTimeoutMs,
      headers: internalServiceHeaders({ serviceToken, tenantId, tenantlessReason: TENANTLESS.PLATFORM_OPERATOR }),
      signal,
    });
    this.recordLlmUsage(tenantId, response.data, null);

    const maxFindings = typeof config.maxFindings === 'number' && config.maxFindings > 0 ? Math.floor(config.maxFindings) : DEFAULT_MAX_FINDINGS;
    return { findings: parseImportantFindings(mapTextGenerateResponse(response.data).summary, maxFindings) };
  }

  /**
   * Resolve a GOVERNED per-node prompt from its `promptTemplateId` binding.
   *
   * Throws rather than defaulting, and the executor turns the throw into a `degraded` outcome
   * with a typed event — so an unconfigured node is VISIBLE to the clinician UI instead of looking
   * like a model that found nothing.
   *
   * Generalised out of `resolveCorrectionPrompt` when Lane N added a second node with the same
   * binding: two copies of "resolve a template, insist it is APPROVED, refuse to default" is two
   * places for the approval check to be forgotten.
   */
  private async resolveGovernedNodePrompt(config: Readonly<Record<string, unknown>>, label: string): Promise<string> {
    const templateId = typeof config.promptTemplateId === 'string' ? config.promptTemplateId : null;
    if (!templateId) throw new Error(`no_${label}_prompt_bound`);
    if (!this.promptTemplateRepository) throw new Error('prompt_repository_unavailable');

    const template = await this.promptTemplateRepository.findById(templateId).catch(() => null);
    if (!template) throw new Error(`${label}_prompt_not_found`);
    // Same bar `PromptResolutionService` holds every governed prompt to.
    if (template.status !== 'APPROVED') throw new Error(`${label}_prompt_not_approved`);
    const content = template.content?.trim();
    if (!content) throw new Error(`${label}_prompt_empty`);
    return content;
  }

  /**
   * extract the AD-1 GenerationStats block from the TEXT
   * `/generate` response for the SSE payload. Passes the normalized headline
   * fields through near-verbatim (snake_case, matching the TEXT contract) minus
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

  // `callNlp` + `mapVitals` were RELOCATED VERBATIM to
  // `live-tool-registry.ts` (`NlpExtractionTool`) — same URL, same payload,
  // same mapping, same 30s timeout. The flush reaches them via the registry.

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

  // `checkGroundedness` + `mapGroundednessResponse` were RELOCATED
  // VERBATIM to `live-tool-registry.ts` (`GuardrailGroundednessTool`) — same
  // endpoint, same bounded retry, same fail-CLOSED mapping.

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

  /**
   * The session's FROZEN agent snapshot. TTL = `LOCK_TTL`,
   * refreshed by the fenced lock-renewal loop, so the pin lives exactly as long
   * as the ownership it belongs to.
   */
  private agentKey(consultationId: string): string {
    return `${this.CHANNEL_PREFIX}${consultationId}:agent`;
  }

  private snapshotKey(consultationId: string): string {
    return `${this.CHANNEL_PREFIX}${consultationId}:last`;
  }

  /**
   * publish an INTERPRETER-produced summary snapshot onto this
   * service's own live-summary plane.
   *
   * ## Why this lives here and not in a service of its own
   *
   * `consultation:live-summary:{id}` and its `:last` snapshot key are this
   * class's surface. A second class publishing to them would duplicate the key
   * derivation and the TTL, and the first divergence would be a silent one —
   * a snapshot written under a key nothing reads. One owner per channel.
   *
   * ## Why the existing channel at all
   *
   * established that the harness has no way to deliver summary TEXT to
   * the gateway: of the 18 `/internal/harness/*` routes, the only text-accepting
   * write creates a `RAW_SUMMARY` ContextItem — the FINAL note, not a
   * mid-consultation snapshot. Publishing here instead means the existing SSE
   * route, `useArcaLiveSummary` and the existing console panel all light up with
   * zero new consumer surface.
   *
   * ## Two publishers on one plane — stated, not hidden
   *
   * When an interpreter graph governs a consultation, this service's own flush
   * loop may still be running (it is started by `recording/start`, independently
   * of the substrate decision), so both can publish here and the later write
   * wins the snapshot. That is acceptable for an EPHEMERAL UX plane — nothing
   * here is persisted per tick and the durable note is unaffected — but it is
   * not invisible: every payload carries `source`, so a consumer can always say
   * which engine produced what it is showing.
   *
   * Best-effort, like every sibling publish path: acks `{ ok: false }` rather
   * than throwing, because a feed hiccup must never fail an interpreter run.
   */
  async publishInterpreterSummary(consultationId: string, dto: HarnessLiveSummaryRequest): Promise<HarnessRealtimeDeliveryAck> {
    const payload: LiveSummaryEventDto = {
      consultationId,
      runningSummary: dto.runningSummary,
      sections: dto.sections ?? [],
      // The interpreter plane runs no NER pass of its own. `entities` is REQUIRED
      // on the DTO, so it is an empty array — never omitted, never fabricated.
      entities: [],
      source: dto.source,
      updatedAt: new Date().toISOString(),
    };

    // Absent optionals are OMITTED, never emitted as null: the harness client
    // prunes on its side and the payload should not reintroduce what it dropped.
    if (dto.nodeType !== undefined) payload.nodeType = dto.nodeType;
    if (dto.ordinal !== undefined) payload.ordinal = dto.ordinal;
    if (dto.total !== undefined) payload.total = dto.total;

    const stats = this.interpreterStats(dto);
    if (stats) payload.metadata = { stats };

    try {
      const serialized = JSON.stringify(payload);
      await this.cacheService.setex(this.snapshotKey(consultationId), this.SNAPSHOT_TTL, serialized);
      await this.cacheService.publish(this.channel(consultationId), serialized);
      this.logger.debug({ message: 'Interpreter live summary published', consultationId, nodeType: dto.nodeType });
      return { ok: true };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to publish interpreter live summary (best-effort — the interpreter run is unaffected)',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false };
    }
  }

  /**
   * The generation-provenance block, in the snake_case shape the console already
   * reads for flush-loop payloads. `null` when the publish carried none of the
   * three — an empty `metadata.stats` would read as "the engine reported
   * nothing", which is different from "the caller sent nothing".
   */
  private interpreterStats(dto: HarnessLiveSummaryRequest): LiveSummaryStatsDto | null {
    if (dto.provider === undefined && dto.model === undefined && dto.taskKey === undefined) return null;
    const stats: LiveSummaryStatsDto = {};
    if (dto.provider !== undefined) stats.provider = dto.provider;
    if (dto.model !== undefined) stats.model = dto.model;
    if (dto.taskKey !== undefined) stats.task_key = dto.taskKey;
    return stats;
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
      textLatencyMs: number;
      nlpLatencyMs: number;
      textFailed: boolean;
      nlpFailed: boolean;
      entityCount: number;
      sectionCount: number;
      summaryChars: number;
      /** TASK-891 B4 — the lane's non-success node outcomes for this flush (empty on the legacy engine). */
      nodeDegrades?: LiveDocNodeDegradeResponse[];
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
      textLatencyMs: metrics.textLatencyMs,
      nlpLatencyMs: metrics.nlpLatencyMs,
      textFailed: metrics.textFailed,
      nlpFailed: metrics.nlpFailed,
      staleDropCount: session.staleDropCount,
      entityCount: metrics.entityCount,
      sectionCount: metrics.sectionCount,
      summaryChars: metrics.summaryChars,
      // Omitted entirely when nothing degraded, so a healthy session's snapshot keeps the
      // shape it had before B4.
      ...(metrics.nodeDegrades && metrics.nodeDegrades.length > 0 ? { nodeDegrades: metrics.nodeDegrades } : {}),
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
