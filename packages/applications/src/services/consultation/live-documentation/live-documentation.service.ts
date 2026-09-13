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
  AiDeploymentKind,
  type ConsultationEntity,
  ConsultationRepository,
  DepartmentRepository,
  ContextItemEntity,
  ContextItemFactory,
  ContextItemRepository,
  ContextItemType,
  DnaWritingStyleReportRepository,
  DocumentSectionRepository,
  PromptTemplateRepository,
  WorkflowDefinitionRepository,
} from '@arcaai/domains';
import { ConfigResolver } from '../../config-resolver';
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
import { validateRedactionRuleSet } from '../../dna-writing-style/redaction-rules';
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
  composePrompt,
  CORE_PALETTE_KEY,
  guardrailOptOutOf,
  PromptCompositionEmptyError,
  PromptTemplateSyntaxError,
  PromptVariableUnresolvedError,
  resolveGuardrailDecision,
  type ComposableResolvedPrompt,
  type ComposedPrompt,
  type ExpressionValue,
} from '@arcaai/workflow-contract';
import { buildAgentPromptScope } from '../../agent/agent-prompt-scope';
import { unwrapSingleKindContextPayload } from '../../consultation-context-schema/context-schema-definition';
// TASK-890 §3.13 (OD-E) — this lane posts straight to `apps/text` and recorded nothing.
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { IUsageLedgerService } from '../../usageLedger/IUsageLedgerService';
import { IComputeDeviceResolver } from '../../usageLedger/compute-device.resolver';
import type { ComputeAugmentedBatch } from '../../usageLedger/compute-units';
import type { UsageEventBatchInput } from '../../usageLedger/dto';
import { withUsageAttributes } from '../../usageLedger/usage-attributes';
import type { ComputeDevice, UsageAttributes } from '../../usageLedger/usage-attributes';
import { buildLlmUsageBatches, parseTextUsageDetail, resolveDeployment, toLedgerProvider, type TextUsageDetail } from '../summary/text-usage';
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
  LiveHandoffResponse,
  type LiveHandoffRecord,
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
import { buildRunningSummary, buildStructuredSummary, parseDocumentJson, parseDocumentSections } from './document-shape-parser';
// TASK-943 — the SAME builder the summary path uses, so the two surfaces cannot drift on what an
// absent clinical variable means.
import { buildPreSummaryVariables } from '../prompt/pre-summary-variables';
// TASK-939 OD-2(a) — the turn contract: schema, parser, fold and the whole-document degrade.
import {
  applyTurn,
  buildTurnResponseFormat,
  parseTurnJson,
  turnInstruction,
  wholeDocumentAsTurn,
  type AppliedTurn,
  type TurnRefusal,
  type TurnSectionWrite,
} from './realtime/turn-contract';
import { readSummaryLanguage, summaryLanguageName } from '../consultation/summary-language';
// TASK-951 D-3 — the visit type the CLIENT recorded at `open`, which wins over the parent-link
// derivation. Read through lane C's one reader so the marker's storage stays its business.
import { readRecordedVisitType } from '../consultation/open-markers';
// TASK-951 D-7 — the SAME cap the carried prior-visit summary is bounded by, applied here so a
// client-supplied history is a bounded prompt input rather than an unbounded one.
import { truncatePriorVisitSummary } from '../harness/prior-visit-summary';
// TASK-932 — the visit type the realtime lane's `core.condition` guards branch on. The SHARED
// instance rather than an injected one: since TASK-882 `VisitTypeService` holds no state, takes
// no dependency and derives the answer from the consultation's own parent link, so the facade
// `ConsultationWorkflowDispatchService` falls back to is the same object either way.
import { DEFAULT_VISIT_TYPE_SERVICE } from '../visit-type/visit-type.service';
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
// TASK-946 D6 — the CLOSED vocabulary of PHI-safe degrade codes, shared with the warm start.
import { LIVE_DEGRADE_FALLBACK, degradeCode } from './degrade-codes';
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
  // TASK-946 D2 — the lane's routing decision, evaluated at session start so the frozen note
  // SHAPE and the summary node that actually runs cannot disagree about the visit.
  resolveBranchHandles,
  runRealtimeLane,
  type RealtimeAgentRef,
  type RealtimeAgentTask,
  type RealtimeAudioSync,
  type RealtimeCapabilities,
  type RealtimeCapabilityKey,
  type RealtimeLane,
  type RealtimeNode,
  type RealtimeResolvedAgentView,
  type RealtimeRunResult,
  type RealtimeTranscriptSegment,
  type RealtimeTranscriptWord,
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
  CONSULTATION_REALTIME_DURABLE_SNAPSHOT_MS_KEY,
  CONSULTATION_REALTIME_GROUNDEDNESS_MAX_RETRIES_KEY,
  CONSULTATION_REALTIME_GROUNDEDNESS_RETRY_BACKOFF_MS_KEY,
  CONSULTATION_REALTIME_GROUNDEDNESS_TIMEOUT_MS_KEY,
  CONSULTATION_REALTIME_HEARTBEAT_MS_KEY,
  CONSULTATION_REALTIME_STATS_TTL_SEC_KEY,
  CONSULTATION_REALTIME_TEXT_MAX_TOKENS_KEY,
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
 * This lane has no `core.variable` handler (`realtime-node-registry.ts`), so it publishes no
 * `vars` / `nodes` roots: binding those to empty objects would claim the run has them and that
 * every field is missing, which is a different — and more misleading — finding than "this lane
 * declares none".
 *
 * TASK-943 — it DOES publish `trigger` now, and must. The seeded agents bind their clinical
 * variables by path (`{ path: 'trigger.context.language' }`), so with no trigger root every one of
 * them was unresolvable and `core.agent` failed closed on the first: the realtime case note never
 * generated at all. The objection the paragraph above records was to binding the root to an EMPTY
 * object — asserting a trigger whose fields are all missing. Supplying the values the session
 * actually has (and, for the fields the v2 data model has no store for, the absence values the
 * workflow's own trigger schema DECLARES) answers that objection rather than overriding it: absent
 * `trigger` still means "this lane has no trigger", and that is now only true of a caller that
 * passes none.
 *
 * TASK-947 §4.1 — the render goes through `composePrompt`, which is what makes a COMPOSITE
 * artifact select its fragments over THIS scope (built once, before any condition), render each
 * fragment on its own and join them. The two single-body forms take that function's other branch,
 * which is `renderTemplate` over this same scope — byte-identical to what this function did
 * before. A fragment names itself in an error as `agent:<slug>#<key>`, so an unresolved variable
 * inside one still degrades the node with the PATH named, exactly as §3.2 requires.
 */
function renderLivePrompt(
  resolvedPrompt: ComposableResolvedPrompt,
  variables: Record<string, unknown>,
  agentSlug: string,
  trigger?: Readonly<Record<string, unknown>> | null,
  contextSchema?: ResolvedTextCandidate['contextSchema'],
): ComposedPrompt {
  try {
    // Scope construction is INSIDE the try: a `{ path }` binding is resolved through the same
    // grammar, so an unresolvable binding raises here and must degrade the node with the path
    // named rather than escape as an unhandled error.
    //
    // TASK-947 R1 #1 — `context` is the J3-5 VIEW of the trigger (the single kind unwrapped when
    // the agent's frozen schema declares one), exactly as the invocation route, the bench and the
    // durable lane's `_prompt_scope` publish it. This lane was the one renderer that aliased the
    // raw payload, so `context.visit_type` selected a fragment on three lanes and was a silent
    // `condition_error` on this one. `trigger` stays the payload verbatim.
    const context = trigger ? (unwrapSingleKindContextPayload(contextSchema?.payloadSchema ?? null, trigger) as Record<string, unknown>) : undefined;
    const scope = buildAgentPromptScope({ variables, trigger, context, templateRef: `agent:${agentSlug}` });
    return composePrompt(resolvedPrompt, scope, { templateRef: `agent:${agentSlug}` });
  } catch (error) {
    if (error instanceof PromptVariableUnresolvedError) {
      throw new LivePromptUnresolvedError(`core.agent: prompt_variable_unresolved: ${error.path} (agent '${agentSlug}')`);
    }
    if (error instanceof PromptTemplateSyntaxError) {
      throw new LivePromptUnresolvedError(`core.agent: prompt_template_syntax: ${error.message} (agent '${agentSlug}')`);
    }
    // OD-6, defensive: publish refuses a composite with no unconditional fragment, so reaching
    // here means every fragment's condition was false or unevaluable. Degrading on the FIRST
    // candidate is the same reasoning the two errors above carry — every candidate of this node
    // composes against the same scope and would answer identically.
    if (error instanceof PromptCompositionEmptyError) {
      throw new LivePromptUnresolvedError(`core.agent: prompt_composition_empty (agent '${agentSlug}')`);
    }
    throw error;
  }
}

/**
 * TASK-947 — the candidate's prompt SOURCE in the ONE shape `composePrompt` reads, or `null` when
 * the candidate carries no instruction body at all (the caller then sends
 * `LIVE_DOCUMENT_SYSTEM_PROMPT`, exactly as before).
 *
 * The pre-947 read was `resolvedPrompt?.content ?? instruction.systemPrompt`, guarded on the RAW
 * string's truthiness — an artifact with an empty body falls to the platform prompt. That guard is
 * preserved verbatim for the two single-body forms, and deliberately NOT applied to a composite:
 * a composite's `content` is only the STATIC PROJECTION (OD-3), so a list whose fragments are all
 * conditional carries an EMPTY projection and must still compose, not fall through to a platform
 * prompt the tenant never authored.
 */
function liveCandidatePromptSource(resolvedPrompt: ComposableResolvedPrompt, instruction: Record<string, unknown>): ComposableResolvedPrompt {
  if (resolvedPrompt && resolvedPrompt.source === 'composite') return resolvedPrompt;
  const content = resolvedPrompt?.content ?? (typeof instruction.systemPrompt === 'string' ? instruction.systemPrompt : null);
  return content ? { source: 'inline', content } : null;
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

/**
 * A5 — the client's declared `speaker_label`, when it declared one and it is usable.
 *
 * Defensive by necessity: `metadata` is an arbitrary object an integration declared, validated
 * only against the tenant's `stream` context schema (which does not require this field). A
 * non-string, or a blank one, is NOT a speaker — returning it would put `""` or `[object Object]`
 * where the note expects a name.
 */
function declaredSpeakerLabel(metadata: Record<string, unknown> | undefined): string | undefined {
  const label = metadata?.speaker_label;
  return typeof label === 'string' && label.trim().length > 0 ? label : undefined;
}

/**
 * A live transcript segment fed into the watcher.
 *
 * Everything below `segmentId` is the CORRELATION the STT wire has always carried
 * (`SttTranscriptResult`) and this service used to discard at the door: `attachSttStream` read
 * `msg.text` and nothing else, so by the time a transcript reached the graph lane it was a string
 * with no way back to the audio that produced it. Optional, because a caller that genuinely has
 * only text (a manual ingest, a test) must stay able to say so — and because an engine that does
 * not diarize or does not report word timings should be silent rather than emit a zero a consumer
 * would read as a measurement.
 */
export interface LiveTranscriptSegment {
  text: string;
  isFinal: boolean;
  segmentId?: string;
  /** Seconds from the start of the STT capture, as the engine reported them. */
  startTime?: number;
  endTime?: number;
  /** The PRODUCER's utterance ordinal — what pairs a `gloss` with the final it translates. */
  utteranceIndex?: number;
  /** The GATEWAY's monotonic transcript sequence — what a dropped socket resumes from. Not `utteranceIndex`. */
  seq?: number;
  speaker?: string;
  speakerConfidence?: number;
  language?: string;
  resultType?: 'segment' | 'gloss';
  stableChars?: number;
  inferenceMs?: number;
  /** Per-utterance provenance: a mid-session engine switch splits one transcript across two bindings. */
  pipelineId?: string;
  words?: RealtimeTranscriptWord[];
  /** Epoch ms at which this service received the utterance. Defaulted to `Date.now()` at ingest. */
  receivedAtMs?: number;
  /**
   * A5 — the CLIENT's own metadata in force over this utterance's audio (TASK-951), verbatim.
   *
   * HOPE declares nothing about its shape and interprets none of it: it is whatever the
   * integration declared with a `{ type: 'metadata' }` frame, sticky until the next declaration.
   * In the ArcaAI deployment it is `{ mic_id, speaker_label }` and it is the ONLY source of
   * per-microphone attribution, because that tenant's ASR agent has diarization off — so dropping
   * it here (which this service used to do at the socket) meant a two-microphone consultation
   * reached the note as one undifferentiated speaker.
   *
   * Absent for a session that never declared any, which is every pre-TASK-951 client.
   */
  metadata?: Record<string, unknown>;
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
  /** TASK-939 — only the sections this turn CHANGED, each with the mode it must be written in. */
  turnWrites: TurnSectionWrite[];
  /** Contributions the turn contract refused (an unjustified rewrite). PHI-safe: keys and reasons. */
  turnRefusals: TurnRefusal[];
  /** True when the generation could not be read as a turn and fell back to a whole-document rewrite. */
  turnDegraded: boolean;
  /**
   * A3 — the agent that ACTUALLY SERVED this turn's document node, when one was bound.
   *
   * Absent for a node with no `core.agent` binding, where the session's frozen snapshot is the
   * correct provenance and there is nothing to correct.
   */
  turnAgent?: LiveSummaryAgentDto;
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
  /**
   * The per-utterance metadata for `transcriptParts`, STRICTLY INDEX-ALIGNED with it.
   *
   * A parallel array rather than a richer `transcriptParts`, deliberately. That buffer is read by
   * the drain loop, the delta windowing, the flush cursor and the whole-transcript join, all of
   * which index into it; widening its element type would touch every one of those for no gain,
   * because none of them wants anything but the text. Alignment is the invariant instead, and it
   * holds because `ingestSegment` is the only writer and appends to both in the same breath.
   */
  transcriptSegments: LiveTranscriptSegment[];
  /**
   * Epoch ms that STT segment time `0` maps to — stamped when this service ATTACHES to the
   * result stream, which is the closest observable the gateway gives us to the start of capture.
   *
   * A modest claim, and the doc comment on `RealtimeAudioSync.epochMs` says so: it is not the
   * microphone's clock. It is still the only anchor that turns a producer-relative segment time
   * into something a caller can line up against the audio it sent, and it is checkable —
   * `epochMs + endTime * 1000` must never lead a segment's `receivedAtMs`.
   */
  sttStreamEpochMs?: number;
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
  /**
   * TASK-939 R9 — the one-per-session attempt to resume the PERSISTED note.
   *
   * A promise rather than a boolean, and awaited by every flush, so the resume costs every
   * generation the same single microtask instead of handicapping the first one — see the call site.
   * Settles once; never rejects.
   */
  resumePromise?: Promise<void>;
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
   * The per-utterance metadata for `pendingGraphTranscript`, with offsets into THAT string.
   *
   * Not the session's whole segment list: the capture node publishes the DELTA on most turns, so
   * offsets taken against the session transcript would point past the end of what the node
   * actually emitted. Rebuilt each flush from the same index range the delta was, which is what
   * keeps `charStart`/`charEnd` resolvable in the string the consumer is holding.
   */
  pendingGraphSegments?: RealtimeTranscriptSegment[];
  /** The capture anchor published beside `pendingGraphSegments`. Rebuilt each flush from the session's own. */
  pendingGraphAudio?: RealtimeAudioSync;
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
   * TASK-932 — the consultation's VISIT TYPE key (`new-visit` / `revisit`), frozen at `start()`.
   *
   * It is what the seeded consultation graph's `core.condition` branches on
   * (`trigger.context.visit_type`), and it is derived exactly as
   * `ConsultationWorkflowDispatchService.visitTypeSelectorTags` derives it — from the
   * consultation's own parent link — so the workflow that was ASSIGNED and the branch that is
   * TAKEN cannot disagree about which visit this is.
   *
   * `undefined` = the gateway could not determine one (no consultation repository, or the read
   * failed). The guard expressions then error and the condition takes `else`, which is the
   * seeded graph's own new-visit branch — observable in `RealtimeRunResult.branchEvaluations`
   * rather than silently indistinguishable from a real `new-visit`.
   */
  visitType?: string;
  /**
   * TASK-943 — the consultation's department, frozen off the SAME row read that freezes
   * `summaryLanguage` and `visitType`, so the agent's `current_department` variable costs no extra
   * I/O. `departmentName` is the resolved name, cached after the first lookup.
   */
  departmentId?: string | null;
  departmentName?: string | null;
  /**
   * TASK-951 D-7 — the CLIENT-supplied clinical inputs (`vitals`, `previous_case_notes`) this
   * consultation was opened with, resolved at most once per session.
   *
   * A promise rather than a value, and memoized, so two flushes racing the first resolution share
   * one read instead of issuing two — the same discipline `agentPromise` / `templatePromise` /
   * `lanePromise` use, and for the stronger reason that this read DECRYPTS. Settles once; never
   * rejects: a history that cannot be read must degrade to "no prior visits", never to no note.
   */
  clientContextPromise?: Promise<LiveClientContext>;
  clientContext?: LiveClientContext;
  /**
   * TASK-932 R-16a — the live lane's LAST SUCCESSFUL output per node id, accumulated across
   * flushes and handed to the durable interpreter at `stop()`.
   *
   * Per NODE and last-write-wins, not per flush: a flush in which NER degraded must not erase
   * the entities the previous one produced, because what the finalizer needs is "the best the
   * live lane got to", not "whatever the final flush happened to return".
   *
   * The shape is the realtime executor's own `RealtimeRunResult.outputs`, unaltered, which is
   * what lets the interpreter resolve it through the same declared socket table it uses for a
   * node it ran itself (`_resolve_bound_inputs`).
   */
  liveNodeOutputs?: Record<string, Record<string, unknown>>;
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
/**
 * TASK-932 R-16a — the consultation lifecycle states from which the live lane can STILL hand
 * something off. Everything else means capture is over, whether or not a handoff record exists.
 *
 * `DRAINING` is deliberately NOT here. It means "capture stopped, not yet drafted", so nothing
 * further is coming — and treating it as live would park a durable run for two hours whenever a
 * stop was routed to an instance that owned no session and therefore wrote no record.
 */
const LIVE_CAPTURE_STATUSES: ReadonlySet<string> = new Set(['OPEN', 'PRIMED', 'RECORDING', 'REOPENED']);

/** The effective `agentic.context.*` knobs for one resolution. */
export interface AgenticContextKnobs {
  liveDeltaMaxChars: number;
  segmentThreshold: number;
  idleMs: number;
  /** TASK-939 R7 — minimum ms between TEXT calls for one session (was a constructor env freeze). */
  minIntervalMs: number;
  transcriptMode: AgenticTranscriptMode;
  tokenBudgetPerRun: number;
}

/**
 * TASK-940 — the effective `consultation.realtime.*` budgets for one resolution.
 *
 * These seven were constructor-frozen `LIVE_DOC_*` env reads. They are refreshed
 * per flush by {@link LiveDocumentationService.resolveRealtimeBudgets}, the same
 * shape `AgenticContextKnobs` uses, so a registry write governs the next flush
 * with no redeploy. `heartbeatMs` is the one whose consumer is a SUBSCRIPTION
 * rather than a flush — see its descriptor for the granularity that follows.
 */
export interface RealtimeBudgets {
  heartbeatMs: number;
  durableSnapshotMs: number;
  statsTtlSec: number;
  textMaxTokens: number;
  groundednessTimeoutMs: number;
  groundednessMaxRetries: number;
  groundednessRetryBackoffMs: number;
}

/**
 * TASK-943 — render the session's extracted vitals as the one-line text the prompt's
 * `{{formatted_vitals}}` expects, or `undefined` when there is nothing to report.
 *
 * `undefined` rather than an empty string on purpose: the caller then falls through to the DECLARED
 * absence value (`Not available`) instead of handing the model a blank where a reading belongs. The
 * inverse matters more — claiming `Not available` while the session HOLDS readings is a falsehood,
 * not a default, which is why this exists at all rather than always using the default.
 *
 * Blood pressure is emitted as the `systolic/diastolic` pair clinicians read it as, and only when
 * BOTH halves are present: a lone systolic is not a blood pressure.
 */
function formatVitalsForPrompt(vitals?: LiveSummaryVitalsDto): string | undefined {
  if (!vitals) return undefined;
  const parts: string[] = [];
  if (vitals.systolic != null && vitals.diastolic != null) parts.push(`BP ${vitals.systolic}/${vitals.diastolic} mmHg`);
  if (vitals.heartRate != null) parts.push(`HR ${vitals.heartRate} bpm`);
  if (vitals.spo2 != null) parts.push(`SpO2 ${vitals.spo2}%`);
  if (vitals.temperatureC != null) parts.push(`Temp ${vitals.temperatureC}\u00b0C`);
  if (vitals.weightKg != null) parts.push(`Weight ${vitals.weightKg} kg`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * TASK-951 (owner amendment to OD-4) — the NORMALISED vitals object a client may state at `open`.
 *
 * Every field is optional, which is the whole point: a client sends the readings it took, and a
 * missing field means "not measured", never zero. `bloodPressure` is a STRING because that is how
 * the pair is recorded and read (`128/82`); splitting it into two numbers here would invent a
 * precision the source does not have. `temperature` is °C and `oxygenSaturation` is a percentage —
 * the units are fixed by the declaration rather than carried per reading, so there is no unit to
 * mis-read at render time.
 *
 * Deliberately declared HERE rather than imported: the kind's JSON Schema (lane B/A) is the
 * contract, and this is the narrow projection this one renderer needs from a payload that has
 * already been validated against it.
 */
interface ClientVitalsPayload {
  bloodPressure?: string;
  heartRate?: number;
  respiratoryRate?: number;
  temperature?: number;
  oxygenSaturation?: number;
  weightKg?: number;
  heightCm?: number;
  bmi?: number;
  bloodGlucose?: number;
  painScore?: number;
  recordedAt?: string;
  notes?: string;
}

/**
 * TASK-951 D-7 — render a CLIENT-supplied vitals object as the `{{formatted_vitals}}` line, or
 * `undefined` when it states nothing.
 *
 * `undefined` rather than `''` for the same reason {@link formatVitalsForPrompt} returns it: the
 * caller then falls through to the next source, and finally to the DECLARED absence value
 * (`Not available`), instead of handing the model a blank where a reading belongs.
 *
 * Why this outranks {@link formatVitalsForPrompt}: that one reports what the SESSION extracted from
 * the conversation — a model's reading of speech. This one is what the clinic MEASURED and sent. A
 * measured reading is not a competing opinion to a transcribed one; it is the fact the transcription
 * is at best an echo of, so when both exist the measured one is what the note should carry.
 *
 * `recordedAt` rides on the same line rather than being dropped, because a vitals set with no time
 * reads as "now" to a model, and a set taken at triage two hours before the consultation is a
 * different clinical statement from one taken during it. `notes` takes a second line: it is free
 * text of unbounded length and folding it into the reading list would make the readings unparsable
 * by eye.
 */
function formatClientVitalsForPrompt(vitals: ClientVitalsPayload | undefined): string | undefined {
  if (!vitals) return undefined;
  const parts: string[] = [];
  const bp = vitals.bloodPressure?.trim();
  if (bp) parts.push(`BP ${bp} mmHg`);
  if (vitals.heartRate != null) parts.push(`HR ${vitals.heartRate} bpm`);
  if (vitals.respiratoryRate != null) parts.push(`RR ${vitals.respiratoryRate} /min`);
  if (vitals.temperature != null) parts.push(`Temp ${vitals.temperature} °C`);
  if (vitals.oxygenSaturation != null) parts.push(`SpO2 ${vitals.oxygenSaturation} %`);
  if (vitals.weightKg != null) parts.push(`Wt ${vitals.weightKg} kg`);
  if (vitals.heightCm != null) parts.push(`Ht ${vitals.heightCm} cm`);
  if (vitals.bmi != null) parts.push(`BMI ${vitals.bmi}`);
  if (vitals.bloodGlucose != null) parts.push(`Glucose ${vitals.bloodGlucose} mg/dL`);
  if (vitals.painScore != null) parts.push(`Pain ${vitals.painScore}/10`);

  // A `recordedAt` (or a note) with NO readings states nothing about the patient: emitting
  // `recorded 09:40` on its own would tell the model a vitals set exists when none was sent.
  if (parts.length === 0) return undefined;

  const notes = vitals.notes?.trim();
  const recordedAt = vitals.recordedAt?.trim();
  if (recordedAt) parts.push(`recorded ${recordedAt}`);
  const line = parts.join(' · ');
  return notes ? `${line}\n${notes}` : line;
}

/** One entry of the client-supplied `previous_case_notes` kind. Only `text` is required. */
interface ClientPreviousCaseNote {
  date?: string;
  department?: string;
  doctor?: string;
  title?: string;
  text?: string;
}

/**
 * TASK-951 D-7 / OD-5 — render the CLIENT-supplied previous case notes as
 * `{{formatted_previous_visits}}`, or `''` when there are none.
 *
 * `''` rather than `undefined`, because that is the value the workflow's own trigger-context
 * schema declares for this name and the realtime lane published before this ticket — an absent
 * history and a supplied-but-empty one are the same statement to the prompt, and both are "no
 * prior visits to report", never a missing variable the agent would fail closed on.
 *
 * ## Ordering
 *
 * Most recent first, because a prompt that runs out of budget should lose the oldest visit rather
 * than the last one. The sort is applied only to notes whose `date` actually PARSES: a free-text
 * date ("last monsoon") is not evidence of position, so those keep the order the client sent them
 * in and fall after the dated ones. `Array.prototype.sort` is stable, which is what makes that
 * second half a statement rather than an accident.
 *
 * ## Bounding
 *
 * Through the SAME {@link truncatePriorVisitSummary} the carried prior-visit summary uses, marker
 * and all — a truncated history must not read as a complete one. Whole notes are not dropped to
 * fit: cutting mid-note leaves the marker visible, whereas silently omitting a visit would make
 * the history look shorter than it is.
 */
function formatPreviousVisitsForPrompt(notes: readonly ClientPreviousCaseNote[] | undefined): string {
  if (!notes || notes.length === 0) return '';

  const dated = notes.map((note, index) => {
    const parsed = note.date ? Date.parse(note.date) : Number.NaN;
    return { note, index, at: Number.isNaN(parsed) ? null : parsed };
  });
  dated.sort((a, b) => {
    if (a.at === null && b.at === null) return a.index - b.index;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return b.at - a.at;
  });

  const rendered = dated
    .map(({ note }) => {
      const heading = [note.date, note.department, note.doctor, note.title].map((part) => part?.trim()).filter((part): part is string => !!part);
      const text = note.text?.trim() ?? '';
      if (!text) return '';
      return heading.length > 0 ? `${heading.join(' · ')}\n${text}` : text;
    })
    .filter((entry) => entry.length > 0);

  return rendered.length > 0 ? truncatePriorVisitSummary(rendered.join('\n\n')) : '';
}

/**
 * TASK-951 D-7 — the client-supplied prompt inputs this session resolved from its consultation's
 * PRE context items, resolved ONCE per session.
 *
 * Both halves are written at `open` and never change for the life of the consultation, so this is
 * frozen exactly as `summaryLanguage` / `visitType` / `departmentId` are — a flush every few
 * seconds must not re-read and re-decrypt two rows that cannot have moved.
 */
interface LiveClientContext {
  vitals?: ClientVitalsPayload;
  previousVisits: readonly ClientPreviousCaseNote[];
}

/** The kind keys the realtime prompt lane reads. Both are declared by the tenant's scribe schema. */
const CLIENT_VITALS_KIND_KEY = 'vitals';
const CLIENT_PREVIOUS_CASE_NOTES_KIND_KEY = 'previous_case_notes';

/** A JSON object — not an array, not null. The shape every declared STRUCTURED kind persists as. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The NEWEST context item carrying this kind key, or `null`.
 *
 * Newest rather than first: a kind declared `ONE` is written once at `open`, but a re-open or a
 * later correction can leave two rows behind, and the prompt must carry what the client last said.
 * The comparison is on `createdAt` rather than on position, so the answer does not depend on the
 * finder's sort staying ascending.
 */
function latestContextItemOfKind(items: readonly ContextItemEntity[], kindKey: string): ContextItemEntity | null {
  let latest: ContextItemEntity | null = null;
  for (const item of items) {
    if (item.kindKey !== kindKey) continue;
    if (!latest || item.createdAt >= latest.createdAt) latest = item;
  }
  return latest;
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
 * TASK-893 — WHICH node is the summary one is answered by its CAPABILITY, never by a type
 * string: every realtime node is a `core.agent` now, so matching on the type would pick the
 * transcription node's reason as often as the summary node's.
 *
 * TASK-946 D6 — and the answer is now a CODE from the closed vocabulary in `degrade-codes.ts`.
 * It used to be `${status}: ${reason}`, and `reason` on a TEXT failure is the transport's own
 * message, so the clinician's `section.patch` envelope carried
 * `degraded: Request failed with status code 502` — the HTTP client's words, on the field whose
 * whole job is to say what happened to the note. A node whose reason is ALREADY a code (every
 * skip, every stale, every budget) keeps that code, which is more specific than any
 * classification of it.
 */
function realtimeDegradeReason(run: RealtimeRunResult, lane: RealtimeLane): string | undefined {
  if (run.events.length === 0) return undefined;
  const capabilities = realtimeCapabilityIndex(lane);
  const event = run.events.find((e) => capabilities.get(e.nodeId) === 'generateDocument') ?? run.events[0];
  // The STATUS is the more reliable signal for a timeout: the executor reports it as `timed-out`
  // whatever the underlying call said.
  return event.status === 'timed-out' ? 'timeout' : degradeCode(event.reason, LIVE_DEGRADE_FALLBACK);
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

  /**
   * TASK-932 R-16a — the LIVE HANDOFF record, `+ consultationId` → JSON {@link LiveHandoffRecord}.
   *
   * Redis rather than a column: this is TRANSIENT handoff state consumed seconds after it is
   * written (the interpreter polls on a 15s interval), it is the same class of state as the
   * session snapshot and the agent freeze this service already mirrors here, and it carries the
   * clinical note — which the `WorkflowRun` read model has no encrypted column for and must not
   * be given a plaintext one.
   */
  private readonly HANDOFF_PREFIX = 'live-doc:handoff:';
  /** Matches the interpreter's own `_LIVE_HANDOFF_MAX_WAIT`: past it, nothing is still asking. */
  private readonly HANDOFF_TTL = 7200; // 2h

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
  private readonly envMinIntervalMs?: number;
  /**
   * TASK-940 — the EFFECTIVE realtime budgets, refreshed by
   * {@link resolveRealtimeBudgets} on every flush. Was seven `readonly` fields
   * read once in the constructor, which made every one of them a redeploy.
   *
   * Held as one object rather than seven fields for the same reason
   * `lastAgenticContext` is: the synchronous consumers (`subscribeToLiveSummary`'s
   * heartbeat, the durable-snapshot gate) cannot await, so they read the last
   * resolved snapshot — and one snapshot updated atomically per flush cannot be
   * half-new the way seven independently-assigned fields can.
   */
  private realtimeBudgets: RealtimeBudgets;
  /**
   * The env OVERRIDES for the four budgets that kept one, or undefined where the
   * deployment does not pin them. Captured, never treated as the effective value:
   * the authority is the `consultation.realtime.*` descriptor resolved per flush.
   * Two (`heartbeatMs`, `statsTtlSec`) had their env names RETIRED — nothing set
   * either in any deployment or any fixture. `durableSnapshotMs` kept its name
   * because three fixtures set it (one to `0`, a meaningful value) through a
   * harness that wires no settings facade at all.
   */
  private readonly envRealtimeBudgets: Partial<RealtimeBudgets>;
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
  // `textProvider` / `textModel` were here, seeded from `LIVE_DOC_TEXT_PROVIDER` /
  // `LIVE_DOC_TEXT_MODEL`. TASK-940 deleted both: all three TEXT call sites
  // overwrite the pair from `resolveTextSelection`, and the module imports
  // `HarnessPolicyServiceModule`, so the env seed was unreachable in every
  // deployed path — while contradicting TASK-876's rule that the tenant's
  // assigned TEXT_GENERATION agent selects and an engine id is never an env var.
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
  /**
   * TASK-940 — the groundedness tool's dependency bundle, held by IDENTITY by
   * `LiveToolRegistry` (a session's tool plan is frozen at start). Its three
   * numeric budgets are mutated in place by {@link resolveRealtimeBudgets}, which
   * is the only way a later flush's resolved value reaches a plan already built —
   * exactly the mechanism `toolEnvDefaults` uses for the groundedness GATE.
   */
  private readonly groundednessToolBudgets: {
    httpService: HttpService;
    guardrailServiceUrl: string;
    logger: LiveDocumentationService['logger'];
    secretsService?: SecretsService;
    timeoutMs: number;
    maxRetries: number;
    retryBackoffMs: number;
  };
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
    // TASK-932 R-16a — the two halves of the clinician's EFFECTIVE DNA writing style, resolved
    // at the live HANDOFF so the durable finalizer's `{{context.dna_style_text}}` renders. The
    // repository supplies the report (id + ciphertext); `ConfigResolver` answers the tenant AND
    // doctor gate the doctor-facing reads already respect. Optional + trailing so every
    // positional fixture keeps its arity; ABSENT ⇒ the handoff carries no style and the note is
    // finalized in plain clinical prose, which is what the seeded instruction's
    // `default("")` already means. Never a substituted default: a style nobody enabled must not
    // shape a clinical note.
    @Optional() @Inject(DnaWritingStyleReportRepository) private readonly dnaReportRepository?: DnaWritingStyleReportRepository,
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // TASK-943 — resolves `current_department` for the agent's declared trigger context. Optional +
    // trailing so every positional fixture keeps its arity; ABSENT ⇒ the name falls back to
    // `buildPreSummaryVariables`' documented default, exactly as `PromptAssemblyService` does when
    // its own department lookup cannot answer. The note must still be produced.
    @Optional() @Inject(DepartmentRepository) private readonly departmentRepository?: DepartmentRepository,
    // TASK-959 §3.1 — which device a SELF-HOSTED engine ran on. This is the highest-frequency
    // generation path there is (one call per flush, per open consultation) and it runs on the
    // platform's own engines by default, so without the device every one of those calls was
    // billed for its tokens and nothing else. Optional + trailing like the ledger above it.
    @Optional() @Inject(IComputeDeviceResolver) private readonly computeDevice?: IComputeDeviceResolver,
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
    // TASK-940 — the seven former constructor freezes. Env is captured as an
    // OVERRIDE for the four that kept one; the effective values are re-resolved
    // per flush by `resolveRealtimeBudgets`, so a registry write governs the next
    // flush with no redeploy. Seeded here so the value before the first flush is
    // the one that flush would resolve.
    this.envRealtimeBudgets = {
      durableSnapshotMs: readNumericEnv(this.configService, 'LIVE_DOC_DURABLE_SNAPSHOT_MS'),
      textMaxTokens: readNumericEnv(this.configService, 'LIVE_DOC_TEXT_MAX_TOKENS'),
      groundednessTimeoutMs: readNumericEnv(this.configService, 'LIVE_DOC_GROUNDEDNESS_TIMEOUT_MS'),
      groundednessMaxRetries: readNumericEnv(this.configService, 'LIVE_DOC_GROUNDEDNESS_MAX_RETRIES'),
      groundednessRetryBackoffMs: readNumericEnv(this.configService, 'LIVE_DOC_GROUNDEDNESS_RETRY_BACKOFF_MS'),
    };
    this.realtimeBudgets = this.realtimeBudgetFallback();
    // Kill-switch (P2): any value other than the literal 'false' keeps it on.
    this.enabled = String(this.configService.get('LIVE_DOC_ENABLED') ?? 'true') !== 'false';
    // Min ms between TEXT calls for one session — protects the small local LM pool (P0-A).
    //
    // TASK-939 R7 — the env value is an OVERRIDE now, not the answer: the effective value is
    // re-resolved per flush through `agentic.context.liveFlush.minIntervalMs`, so a super admin's
    // registry write governs the very next flush with no redeploy. Seeded here so the value before
    // the first flush is the one that flush would resolve.
    this.envMinIntervalMs = readNumericEnv(this.configService, 'LIVE_DOC_MIN_INTERVAL_MS');
    // Bounded live-generation params (P0-B).
    // TASK-891 B1 — the env value is an OVERRIDE, not the answer, and it loses to a
    // stored registry value. The old hard-coded `?? 20000` fallback sat below the
    // measured p50 of the generation it bounded, so every realtime flush timed out.
    this.envTextTimeoutMs = readNumericEnv(this.configService, 'LIVE_DOC_TEXT_TIMEOUT_MS');
    this.textTimeoutMs = this.envTextTimeoutMs ?? CONSULTATION_REALTIME_DEFAULTS[CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY];
    // TTL on the per-session Redis stats snapshot + active set. A
    // crashed/quiet session falls out of the admin "live" list after this window;
    // refreshed on every flush so an actively-flushing session stays visible.
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

    // `envDefaults` is the PRE-C4 answer for every tool: NER and
    // vitals always ran; groundedness ran iff `LIVE_DOC_GROUNDEDNESS_ENABLED`.
    // A plan entry of `enabled: null` ("follow the platform default", distinct
    // from `false`) resolves to exactly these — which is why an unconfigured
    // `toolConfig` reproduces today's behavior byte for byte.
    // Held by identity - see the field's doc.
    this.toolEnvDefaults = { ner: true, vitals: true, groundedness: this.groundednessEnabled };
    this.groundednessToolBudgets = {
      httpService: this.httpService,
      guardrailServiceUrl: this.guardrailServiceUrl,
      logger: this.logger,
      secretsService: this.secretsService,
      timeoutMs: this.realtimeBudgets.groundednessTimeoutMs,
      maxRetries: this.realtimeBudgets.groundednessMaxRetries,
      retryBackoffMs: this.realtimeBudgets.groundednessRetryBackoffMs,
    };
    this.toolRegistry = new LiveToolRegistry({
      nlp: {
        httpService: this.httpService,
        nlpServiceUrl: this.nlpServiceUrl,
        logger: this.logger,
        cls: this.cls,
        routingPolicies: this.routingPolicies,
        secretsService: this.secretsService,
      },
      // TASK-940 — the three numeric budgets are MUTATED in place by
      // `resolveRealtimeBudgets` rather than re-passed, because `LiveToolRegistry`
      // captures this object by identity in a session's frozen tool plan. Same
      // mechanism `toolEnvDefaults` uses one line below, and for the same reason:
      // reassigning a field on the service would never reach a plan already built.
      groundedness: this.groundednessToolBudgets,
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
      transcriptSegments: [],
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
    session.substratePromise = this.ensureSubstrateResolved(session);
    // Same fire-and-forget shape, same reason: freeze the document
    // shape at session start so a mid-consultation publish cannot change the
    // note being produced. `flush()` awaits the memoized promise.
    //
    // TASK-891 D7 — AFTER the lane, and that order is load-bearing: the note's shape is
    // named by the governing workflow's realtime summary node, so the template cannot be
    // resolved until the lane it is named on exists.
    //
    // TASK-946 D2 — and AFTER the substrate read, which is the second load-bearing edge. The
    // shape is named by the summary node the VISIT BRANCH reaches, and the visit type is frozen
    // off the consultation row by `ensureSubstrateResolved`. Kicked off in this order (and
    // awaited inside `ensureTemplateResolved`) so the branch is evaluated against a frozen
    // `session.visitType` rather than against `undefined` — which is exactly what the previous
    // ordering would have handed it.
    session.templatePromise = this.ensureTemplateResolved(session);
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
    const serialized = JSON.stringify(event);
    // Cached BEFORE the publish, so there is no window in which a subscriber sees the live event
    // while a late joiner would still be told there was none.
    await this.cachePreSummary(session.consultationId, serialized);
    await this.safeChannelPublish(this.channel(session.consultationId), serialized);
  }

  /**
   * Remember the last `presummary` event for late join, under its OWN key.
   *
   * The warm start runs in parallel with the capture session opening, so it routinely publishes
   * before the console's SSE stream has subscribed — measured on the dev stack: `degraded` at
   * +29 ms, subscribe at +56 ms, and the panel never appeared. `safeChannelPublish` writes no
   * cache at all, and the whole-document `…:last` key is not available to borrow (answering a
   * reconnect with a pre-summary would replace the clinician's document with its background
   * material), so this is a companion key on the same TTL.
   *
   * Best-effort in its own right: a cache failure costs a LATE joiner its replay and must never
   * cost a live one its event, which is why it neither throws nor short-circuits the publish.
   */
  private async cachePreSummary(consultationId: string, serialized: string): Promise<void> {
    try {
      await this.cacheService.setex(this.preSummaryKey(consultationId), this.SNAPSHOT_TTL, serialized);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to cache the pre-summary for late join (the live publish is unaffected)',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
   *
   * ## TASK-946 D2 — the shape follows the VISIT BRANCH
   *
   * A graph that splits its per-turn summary by visit type names a template on BOTH summary
   * nodes, and the seed declares the new-visit one first, so reading "the first node that names
   * one" froze the new-visit shape on every revisit. The lane already carried the decision, so
   * the fix is to make it: evaluate the lane's conditions ONCE, against the same run context the
   * flush evaluates them against, and take the slug off a node that decision can reach.
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
      // TASK-946 D2 — the visit type is frozen by the SUBSTRATE read (`start()` kicks it off
      // immediately before this promise), and the branch cannot be evaluated without it.
      // Awaited rather than re-invoked: a second `ensureSubstrateResolved` would repeat the
      // stand-down decision, and this method must not be able to tear a session down twice.
      if (session.substratePromise) await session.substratePromise;
      const branchHandles = lane && lane.conditions.length > 0 ? resolveBranchHandles(lane, await this.realtimeRunContext(session)) : [];
      const laneSlug = realtimeDocumentTemplateSlug(lane, branchHandles);
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
        // ...and WHICH branch reached it. PHI-safe: node ids and branch handles only. Absent on
        // an unbranched lane, which is every lane authored before the visit-type split.
        visitType: session.visitType ?? null,
        branchHandles: branchHandles.map(({ nodeId, handle, matched }) => ({ nodeId, handle, matched })),
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
      // ...and the visit type off the same row, for the same reason. `forConsultation` is pure.
      //
      // TASK-951 D-3 — the RECORDED value wins over the parent link. A client that stated
      // `visit_type` at `open` knows something the link does not: a first visit at this department
      // for a patient who has a prior consultation elsewhere is still a new visit, and a revisit
      // whose earlier encounter never existed in HOPE is still a revisit. `selectVisitType` falls
      // back to the link whenever nothing was recorded, so an untouched consultation is unchanged.
      session.visitType = DEFAULT_VISIT_TYPE_SERVICE.forConsultation(session.tenantId, {
        isFollowUp: Boolean(consultation?.parentConsultationId),
        recorded: readRecordedVisitType(consultation?.metadata),
      }).key;
      // TASK-943 — and the department, for the third time for the same reason: the agent declares
      // `current_department`, and resolving it from anywhere else would be a second read of a row
      // this line already has in hand.
      session.departmentId = consultation?.departmentId ?? null;
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

      // TASK-932 R-16a — HAND OFF to the durable lane, before the session is torn down and
      // while its accumulated node outputs still exist. This is what unblocks `n_finalize`:
      // until it is written the interpreter's poll answers `ended: false` and it keeps waiting,
      // which is the correct reading of "the clinician has not stopped yet".
      await this.persistLiveHandoff(session);

      this.teardownLocal(session);
    }

    // Drop this session from the admin live view (stats key +
    // active-set member). When stop is routed to a non-owner instance the
    // tenant is unknown here, so we can only delete the consultation-keyed stats
    // snapshot; the orphaned active-set member self-heals on the next
    // `getActiveSessions` read and via the set's TTL.
    await this.clearStats(consultationId, session?.tenantId);
    // …and the pre-summary replay key with it. It carries the 1h `SNAPSHOT_TTL` so a late joiner
    // of a LIVE session sees the warm start it missed; left behind, a consultation reopened
    // inside that hour replays the PREVIOUS session's material to its next late joiner. Runs on
    // the non-owner path too, for the same reason `clearStats` does. The whole-document `:last`
    // key deliberately survives: its final write is the terminal `closed: true` payload below,
    // which is exactly what a late joiner of a finished consultation should see.
    await this.clearPreSummary(consultationId);

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
    // Index-aligned with the push above — the invariant `transcriptSegments` documents. `text` is
    // the TRIMMED text, which is what the transcript is joined from and therefore what any offset
    // computed later has to be measured against; storing `segment.text` raw here would make every
    // `charStart` off by the leading whitespace.
    session.transcriptSegments.push({ ...segment, text, receivedAtMs: segment.receivedAtMs ?? Date.now() });

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
  /**
   * Seed `session.lastPayload` from the PERSISTED `DocumentSection` rows, once per session.
   *
   * `lastPayload` lives only in this process's `LiveSession`: `stop()` deletes the session, a lost
   * owner lock tears it down, and a pod restart or ownership handoff builds a fresh one. The next
   * flush then saw an EMPTY prior note and `buildTextUserPrompt` switched to its FIRST-TURN
   * instruction — so a second recording segment, or a reconnect after a restart, silently RESTARTED
   * the case note instead of continuing it. Nothing read the persisted note back:
   * `findLiveSnapshotRow` deliberately touches only `_metadata`.
   *
   * The rows are the right source rather than the durable snapshot blob, because they are what the
   * turn contract folds onto AND they carry the clinician's CONFIRMED text.
   *
   * Never throws and never rejects: this is on the live flush path, and a failed resume must degrade
   * to the previous behaviour (a fresh note) rather than fail the flush.
   */
  private async resumePersistedNote(session: LiveSession, template: ResolvedDocumentTemplate): Promise<void> {
    if (session.lastPayload) return;
    const resumed = await this.sections().readDocument(
      session.tenantId,
      session.consultationId,
      template.slug,
      template.compiled.checklist.map(({ key, title }) => ({ key, title })),
    );
    // A consultation with no rows, or with rows that are all empty, is an ordinary first recording.
    if (!resumed || !resumed.some((section) => section.content.trim().length > 0)) return;
    // Re-checked after the await: a flush that published while this read was in flight owns the
    // note, and overwriting its payload with the older persisted rows would undo it.
    if (session.lastPayload) return;

    const runningSummary = buildRunningSummary(resumed);
    session.lastPayload = { ...this.emptyPayload(session.consultationId), sections: resumed, runningSummary };
    this.logger.log({
      message: 'Resumed the persisted case note for a new live session',
      consultationId: session.consultationId,
      sectionCount: resumed.length,
      // PHI-safe: a size, never the note.
      summaryChars: runningSummary.length,
    });
  }

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
    // a busy session never exceeds one TEXT call per `agentic.context.liveFlush.minIntervalMs`.
    //
    // Read off `lastAgenticContext` — the snapshot the synchronous ingest/debounce paths already
    // use for `idleMs` — because this gate runs BEFORE this flush resolves its own knobs. So a
    // registry write governs from the flush after the one that observes it, which is the same
    // one-flush lag `scheduleFlush` has always had and is what keeps this path synchronous.
    const elapsed = Date.now() - session.lastFlushAt;
    if (!opts?.force && elapsed < this.lastAgenticContext.minIntervalMs) {
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
    // TASK-940 — the seven former constructor freezes, on the same contract.
    await this.resolveRealtimeBudgets(session.tenantId);

    // TASK-939 R9 — resume the note a previous session already wrote.
    //
    // Awaited by EVERY flush through a memoised promise, exactly like the agent, template,
    // substrate and lane resolutions above — and for a reason that is not merely stylistic. A
    // once-only `await` on the first flush is ASYMMETRIC: the first generation ends up one microtask
    // behind every later one, so a forced flush (`stop()`'s) reaches the model FIRST while the
    // opening flush is still resolving. That is an observable reordering of which generation issues
    // which model call, and a background read has no business causing it. Awaiting the same settled
    // promise on every flush costs one microtask for all of them and changes no ordering at all.
    await (session.resumePromise ??= this.resumePersistedNote(session, template));

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
    // The INDEX the delta starts at, tracked beside the text so the per-utterance metadata for
    // exactly this delta can be rebuilt from `transcriptSegments` below. Both branches take a
    // CONTIGUOUS range — `whole` from the cursor forward, `windowed` from the tail back — so a
    // start and an end describe it completely.
    let deltaStart = session.flushedTranscriptCount;
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
      deltaStart = flushUpTo - deltaSegments.length;
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
    const priorSections = session.lastPayload?.sections ?? [];
    // TASK-939 §2.2 — the prior note, WITH ITS STRUCTURE.
    //
    // This used to be `session.lastPayload?.runningSummary`, which is
    // `buildRunningSummary(sections)`: an unlabelled `\n\n` join of the section BODIES, titles and
    // keys discarded. The model was then asked to emit a KEYED document against the compiled
    // template schema, so every turn it had to re-derive which prose belonged to which section —
    // and re-emit all of it. Telling it "merge, don't restart" against a prompt that structurally
    // required a full re-partition is the contradiction that produced the reported defect.
    //
    // `buildRunningSummary` keeps its real job (the offset base NER entities index); it was simply
    // never the right thing to feed back as the prior note. The sections, titles intact, were two
    // lines away the whole time.
    const priorNote = this.renderPriorNote(priorSections, template.compiled);
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
      // TASK-939 OD-2(a) — the turn contract's prose half, kept beside its schema so the two
      // cannot drift.
      turnInstruction(template.compiled),
    );
    // TASK-943 — the run's expression/prompt context, built ONCE per flush. The lane evaluates its
    // guards against it and every `core.agent` renders its instruction from its `trigger` root, so
    // computing it twice would risk the two disagreeing within one turn.
    const runContext = await this.realtimeRunContext(session);
    // The compiled view the TEXT call decodes against THIS turn. A derived object, not a mutation:
    // `template.compiled.responseFormat` is persisted on `DocumentTemplateVersion` and is the
    // durable finalisation path's contract too.
    const turnCompiled: CompiledDocumentTemplate = { ...template.compiled, responseFormat: buildTurnResponseFormat(template.compiled) };

    // TEXT first (a structured S/O/A/P running note), then NER over the resulting
    // `runningSummary` (the canonical text the entity highlight offsets index — so it
    // must be produced before NER runs). Both calls retain the last-good value if the
    // service is down.
    let sections = priorSections;
    // The last-good note, for the degrade paths below. NOT `priorNote`, which is now the STRUCTURED
    // prompt rendering — publishing that as `runningSummary` would put section headings into the
    // text NER offsets index against.
    let runningSummary = session.lastPayload?.runningSummary ?? '';
    // TASK-939 — the per-section writes this flush implies, and what it refused. Empty on a flush
    // that produced nothing; `publishSectionPatches` consumes it instead of re-walking every
    // section, so a quiet section costs no write and publishes no patch.
    let turnWrites: TurnSectionWrite[] = [];
    let turnRefusals: TurnRefusal[] = [];
    /** True when the turn contract could not be honoured and this flush fell back to a full rewrite. */
    let turnDegraded = false;
    /**
     * TASK-939 R11 — where the transcript cursor WOULD advance to, applied only once this flush has
     * survived every staleness check.
     *
     * The cursor used to be written the moment TEXT returned, while two `await`s (the NLP call, and
     * the graph lane's degrade publish) still stood between that point and the final `isStale()`.
     * A `stop()`-forced flush superseding inside either window returned through `dropStale` without
     * ever reaching `session.lastPayload = payload` — so the generation's content was discarded
     * while the cursor stayed advanced past the transcript that produced it, and that stretch of
     * the encounter never reached any note again.
     */
    let cursorAdvanceTo: number | null = null;
    let textFailed = false;
    /**
     * TASK-946 D6 — the LEGACY path's reason code, when its one TEXT call threw.
     *
     * The graph path takes its reason off the lane's degrade events; the legacy path has no
     * events, so the classification happens where the error is actually in hand. `undefined`
     * everywhere else, which is what makes "a reason exists" mean "something went wrong".
     */
    let legacyDegradeReason: string | undefined;
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
    // The metadata for exactly the string above, and over the same index range — `delta` is a
    // WINDOW on most turns, so segments built against the whole session transcript would carry
    // offsets pointing past the end of what the node actually published.
    session.pendingGraphSegments = delta ? this.buildGraphSegments(session, deltaStart, deltaEnd) : this.buildGraphSegments(session, 0, flushUpTo);
    session.pendingGraphAudio = {
      kind: 'stream',
      ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
      ...(session.sttStreamEpochMs === undefined ? {} : { epochMs: session.sttStreamEpochMs }),
    };
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
              turnInstruction(template.compiled),
            ),
          agent,
          template,
          signal,
          isStale,
          priorSections,
          runContext,
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
        turnWrites = graph.turnWrites;
        turnRefusals = graph.turnRefusals;
        turnDegraded = graph.turnDegraded;
        cursorAdvanceTo = deltaEnd;
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
        // Bounded JSON auto-repair. The strict parser is now the TURN parser
        // (TASK-939 OD-2(a)); the tolerant path reproduces the PRE-ticket whole-document
        // behaviour, for a provider that ignores `response_format` and answers with the document
        // rather than with its contribution. A retry only runs when `response_format` was actually
        // sent (structured) — an engine that ignores it returns prose by design, so
        // a retry could never yield JSON and is skipped. The corrective instruction
        // is appended (not prepended) to keep the prefix-cache-stable lead-in intact.
        const outcome = await generateJsonWithRepair<AppliedTurn, LiveSoapCall>({
          generate: async (corrective) => {
            const startedAt = Date.now();
            const { text, stats, structured } = await this.callText(
              promptText,
              session.tenantId,
              signal,
              corrective,
              agent,
              // The turn schema, swapped in by DERIVING a compiled view rather than by threading a
              // new parameter: `responseFormat` is the only field the call path reads, and
              // `CompiledDocumentTemplate.responseFormat` is a persisted artifact the durable
              // finalisation path also decodes against, so it must not be changed in place.
              turnCompiled,
              undefined,
              session.consultationId,
              runContext.trigger as Readonly<Record<string, unknown>>,
            );
            return { text, stats, structured, latencyMs: Date.now() - startedAt };
          },
          parseStrict: (text) => {
            const turn = parseTurnJson(text, template.compiled);
            return turn ? applyTurn(priorSections, turn, template.compiled) : null;
          },
          parseTolerant: (text) => {
            // DEGRADE. Try the whole-document JSON first, then prose — both are "the model answered
            // with the document", which is the old behaviour, so both become replaces and the flush
            // records that it took this path. The churn metric is what makes a tenant stuck here
            // visible instead of silently fine.
            const asJson = parseDocumentJson(text, template.compiled);
            const parsed = asJson && asJson.length > 0 ? asJson : parseDocumentSections(text, template.compiled);
            turnDegraded = true;
            return wholeDocumentAsTurn(parsed, template.compiled);
          },
          // Retry only a genuine malformed-JSON attempt: structured output was
          // requested AND the text opens a JSON object. Clean prose (no leading
          // `{`) is served by the tolerant regex parser with no wasted regen.
          //
          // TASK-939 — and NOT when the text is a well-formed WHOLE-DOCUMENT response. Such an
          // output failed the turn parser but is perfectly usable through the degrade path, so
          // regenerating it buys nothing and costs a second model call on the clinician's live
          // path. Without this, switching to the turn contract silently doubled the calls for
          // every provider that answers with the document.
          shouldRepair: (first) => first.structured && looksLikeJsonObject(first.text) && parseDocumentJson(first.text, template.compiled) === null,
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

        const applied = outcome.value;
        // A turn that changed NOTHING is a real outcome, not a failure: the new transcript may have
        // carried no clinical content. The cursor must still advance — the delta WAS consumed — but
        // nothing is written or published, which is the whole point of an additive contract.
        sections = applied.sections;
        runningSummary = buildRunningSummary(applied.sections);
        turnWrites = applied.writes;
        turnRefusals = applied.refusals;
        // Advance only over the segments actually sent (C5-04): on a truncated
        // flush `deltaEnd < flushUpTo`, so the carried-forward tail is re-sent next.
        //
        // TASK-939 R11 — RECORDED, not written. The write happens after the LAST staleness check
        // (see `cursorAdvanceTo`'s declaration); writing it here left the cursor advanced past a
        // delta whose content a later `dropStale` then discarded.
        cursorAdvanceTo = deltaEnd;
      } catch (error) {
        if (isStale()) return this.dropStale(session);
        textFailed = true;
        // TASK-946 D6 — classified HERE, where the error is in hand; the message stays in the
        // server log and only the code reaches the clinician's feed.
        legacyDegradeReason = degradeCode(error, LIVE_DEGRADE_FALLBACK);
        this.logger.warn({
          message: 'TEXT running-summary call failed',
          consultationId,
          degradeReason: legacyDegradeReason,
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

    // A2 — anchor THIS FLUSH's entities to the utterances that produced them, before anything
    // rebases them onto the note.
    //
    // Both branches above reach the same executor (`toolRegistry.extraction()` — the graph lane's
    // `consultation.extractEntities` node calls it through `capabilities.extractEntities`), so both
    // arrive here carrying raw `transcriptStart`/`transcriptEnd` into `nerSourceText`. And
    // `session.pendingGraphSegments` was built a few dozen lines above over EXACTLY that string,
    // in both modes — which is what makes one anchoring pass correct for both.
    //
    // Applied to the flush's OWN entities only. `priorEntities` were anchored by the flush that
    // extracted them, against a delta that no longer exists; re-anchoring them here would resolve
    // last turn's offsets against this turn's window and cite the wrong utterance.
    extracted = this.anchorEntitiesToTranscript(extracted, session.pendingGraphSegments);
    flushFindings = this.anchorEntitiesToTranscript(flushFindings, session.pendingGraphSegments);

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
      const guardConfig = { timeoutMs: this.realtimeBudgets.groundednessTimeoutMs, maxRetries: this.realtimeBudgets.groundednessMaxRetries };
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

    // A3 — provenance names the agent that RAN THIS TURN, not the one frozen at recording start.
    //
    // The two are the same on a lane with one document node, and different on exactly the lane the
    // clinic runs: a `core.condition` visit-type split has a new-visit node and a revisit node, and
    // the session freeze resolves before the branch is taken. So a revisit consultation published
    // `metadata.agent.{id, promptTemplateId}` for the NEW-VISIT agent beside a
    // `metadata.stats.agent_slug` reading `…-summary-revisit`, in the same envelope — and anyone
    // auditing which prompt wrote a note had two answers and no way to choose.
    //
    // `graph.turnAgent` is derived from the candidate the call actually served (see
    // `turnAgentIdentity`), so the two fields now name one agent by construction. The frozen
    // snapshot remains the answer for a node with no `core.agent` binding and for the legacy path,
    // where it genuinely is what ran.
    const agentMetadata: LiveSummaryAgentDto | null =
      graph?.turnAgent ??
      (agent.promptTemplateId
        ? {
            id: agent.agentId,
            name: agent.agentName,
            promptTemplateId: agent.promptTemplateId,
            promptVersionNumber: agent.promptVersionNumber,
            resolvedFrom: agent.resolvedFrom,
          }
        : null);

    /**
     * TASK-946 D6 — the flush's own verdict, which nothing computed before.
     *
     * `turnDegraded` is a QUALITY signal about a flush that SUCCEEDED (the turn contract fell back
     * to a whole-document rewrite) and `textFailed` names one stage, so a reader of the stats had
     * no field that said "this flush produced no note". Two conditions make one:
     *   - the document generation did not succeed (`textFailed`), or
     *   - an `onError: 'fail'` node stopped the lane (`run.failed`), which no stats field carried.
     */
    const laneDegradeReason = graph ? realtimeDegradeReason(graph.run, lane) : legacyDegradeReason;
    const flushFailed = textFailed || graph?.run.failed === true;
    const flushDegradeReason = flushFailed ? (laneDegradeReason ?? LIVE_DEGRADE_FALLBACK) : undefined;

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
      // TASK-946 D6 — additive and OMITTED on a healthy flush, so a consumer that never looks at
      // them sees the payload it saw before this ticket.
      ...(flushFailed ? { flushFailed: true } : {}),
      ...(flushDegradeReason ? { degradeReason: flushDegradeReason } : {}),
      updatedAt: new Date().toISOString(),
    };

    // TASK-932 R-16a — remember what the LIVE lane produced, per node, for the durable
    // finalizer to bind at stop. Captured HERE and not inside `runGraphLane`: this is the point
    // at which this flush's generation has won every staleness check, so what is recorded is
    // what the clinician actually saw.
    if (graph) this.captureLiveNodeOutputs(session, graph.run);
    // TASK-939 R11 — the cursor advances HERE, past the last staleness check and immediately before
    // the payload becomes the session's last-good. Content and cursor now move together or not at
    // all, so a superseded generation can no longer strand the transcript it consumed.
    if (cursorAdvanceTo !== null) session.flushedTranscriptCount = cursorAdvanceTo;
    session.lastPayload = payload;
    await this.safePublish(consultationId, payload);
    await this.persistDurableSnapshot(session, payload, { force: false });
    // the per-SECTION plane, ADDITIVE to the whole-document
    // payload above so every existing consumer is untouched. Only in graph mode:
    // the legacy engine's contract is "one document, global offsets", and
    // emitting section patches from it would claim a granularity it does not have.
    if (graph) {
      const reconciled = await this.publishSectionPatches(session, {
        sections,
        runningSummary,
        entities,
        findings,
        groundedness,
        template,
        generation: myGeneration,
        // TASK-939 — only the sections this turn changed.
        writes: turnWrites,
        // TASK-891 B5 — WHY this flush produced nothing, when it produced nothing. The
        // summary node's own reason wins over any other node's: it is the one that
        // decides whether there is a note at all. TASK-946 D6 — as a CODE.
        degradeReason: laneDegradeReason,
      });

      // TASK-939 R10 — fold the clinician's CONFIRMED text back into the session's last-good note.
      //
      // `session.lastPayload` is what the NEXT turn's prompt is built from, and it was assigned
      // unconditionally from this flush's MACHINE output a few lines above — including for sections
      // the store had just refused to overwrite because a clinician owned them. The row was
      // protected; the conversation with the model was not, so it kept being shown its own
      // superseded text and kept re-proposing over the edit. The facilitator's "live adjustments"
      // step requires the opposite: once the clinician has corrected a section, that correction is
      // what the assistant works from.
      //
      // Mutating the already-published payload is deliberate and safe: the console never saw a
      // patch for a refused section (none was published), so it is still rendering the confirmed
      // text it already holds. The only consumer this corrects is the next prompt.
      if (reconciled.size > 0) {
        const corrected = payload.sections.map((section, idx) => (reconciled.has(idx) ? { ...section, content: reconciled.get(idx)! } : section));
        payload.sections = corrected;
        payload.runningSummary = buildRunningSummary(corrected);
        session.lastPayload = payload;
      }
    }

    session.flushCount += 1;
    // PHI-safe metrics (P2): sizes/latencies/counts only — never transcript or summary text.
    this.logger.log({
      message: 'Live summary flush',
      consultationId,
      generation: myGeneration,
      flushCount: session.flushCount,
      // TASK-939 — sizes and counts only, never text. `noteChurnChars: 0` is the healthy line: the
      // turn added without rewriting anything the clinician had already read.
      noteChurnChars: this.noteChurnChars(priorSections, sections),
      turnSectionsAppended: turnWrites.filter((write) => write.mode === 'append').length,
      turnSectionsRewritten: turnWrites.filter((write) => write.mode === 'replace').length,
      turnRefusedRewrites: turnRefusals.length,
      turnDegraded,
      // TASK-946 D6 — the flush's own verdict, beside the two stage flags. `turnDegraded` is a
      // quality signal about a SUCCESSFUL flush; this is the one that says there is no note.
      flushFailed,
      ...(flushDegradeReason ? { degradeReason: flushDegradeReason } : {}),
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
      // TASK-939 R7 — the defect, measured. Computed from the note BEFORE and AFTER this turn
      // rather than from the writes, so it reports what a reader actually experienced and cannot
      // be satisfied by a write that claims to be an append while replacing.
      noteChurnChars: this.noteChurnChars(priorSections, sections),
      turnSectionsAppended: turnWrites.filter((write) => write.mode === 'append').length,
      turnSectionsRewritten: turnWrites.filter((write) => write.mode === 'replace').length,
      turnRefusedRewrites: turnRefusals.length,
      turnDegraded,
      // TASK-946 D6 — the flush verdict and its PHI-safe reason code.
      flushFailed,
      ...(flushDegradeReason ? { degradeReason: flushDegradeReason } : {}),
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
      /**
       * TASK-939 — the note BEFORE this turn. The turn contract folds a contribution onto it, so
       * the lane needs what is already written; passed in rather than re-read so the graph and
       * legacy branches fold against byte-identical input.
       */
      priorSections: readonly LiveSummarySectionDto[];
      /**
       * TASK-943 — the run's expression/prompt context, computed ONCE per flush by the caller. The
       * lane evaluates its `core.condition` guards against it AND every `core.agent` renders its
       * instruction from its `trigger` root; without that root the seeded agents' clinical
       * variables (`{ path: 'trigger.context.*' }`) were all unresolvable and every node degraded
       * on the first one, so no note was ever produced.
       */
      runContext: Record<string, ExpressionValue>;
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
    // TASK-939 — what this turn changed, and what it refused. Captured in the closure beside
    // `parsedSections` for the same reason: the projection below is built after the run, and these
    // are produced inside the capability.
    let turnWrites: TurnSectionWrite[] = [];
    let turnRefusals: TurnRefusal[] = [];
    let turnDegraded = false;
    /**
     * A3 — the candidates the document node was allowed to run this turn, captured for PROVENANCE.
     *
     * The session's frozen snapshot (`ctx.agent`) answers "which agent was resolved when recording
     * started", which on a department with a `core.condition` visit-type split is the DEFAULT
     * branch's agent — the new-visit one. The turn may have run the other branch, and `stats
     * .agent_slug` said so while `metadata.agent` kept naming the default. Same object, two
     * different agents. This is the half that was missing.
     */
    let turnCandidates: readonly ResolvedTextCandidate[] | undefined;

    const capabilities: RealtimeCapabilities = {
      // task 14 / — capture PRODUCES the transcript.
      // The declared `out: transcript` port was design intent the durable
      // activity never kept (it emits `{action, consultationId}`), which left the
      // consultation palette with no producer of `transcript` and made
      // `extractEntities`' required input unsatisfiable. Here it is real: the
      // value is the live ASR stream this session ingested.
      transcribe: async () => ({
        transcript: session.pendingGraphTranscript ?? '',
        segments: session.pendingGraphSegments ?? [],
        audio: session.pendingGraphAudio ?? {},
        pipelineId: session.sttPipelineId ?? null,
      }),

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
        // A3 — the primary plus every fallback the call may switch to, in the order `callText`
        // walks them. WHICH of them served is read back off the stats below, because that is the
        // one field that already knows.
        if (textAgent) turnCandidates = [textAgent.spec.primary, ...textAgent.spec.fallback.chain];
        // TASK-939 OD-2(a) — the TURN schema, derived per call. `responseFormat` is the only field
        // the call path reads off `compiled`, and the committed one is a persisted artifact the
        // durable finalisation path decodes against, so it is spread rather than mutated.
        const turnCompiled: CompiledDocumentTemplate = {
          ...ctx.template.compiled,
          responseFormat: buildTurnResponseFormat(ctx.template.compiled),
        };
        const outcome = await generateJsonWithRepair<AppliedTurn, LiveSoapCall>({
          generate: async (corrective) => {
            const startedAt = Date.now();
            const { text, stats, structured } = await this.callText(
              promptText,
              session.tenantId,
              signal,
              corrective,
              ctx.agent,
              turnCompiled,
              textAgent,
              session.consultationId,
              ctx.runContext.trigger as Readonly<Record<string, unknown>>,
            );
            return { text, stats, structured, latencyMs: Date.now() - startedAt };
          },
          parseStrict: (text) => {
            const turn = parseTurnJson(text, ctx.template.compiled);
            return turn ? applyTurn(ctx.priorSections, turn, ctx.template.compiled) : null;
          },
          parseTolerant: (text) => {
            // DEGRADE to the pre-ticket whole-document behaviour — see `wholeDocumentAsTurn`.
            const asJson = parseDocumentJson(text, ctx.template.compiled);
            const parsed = asJson && asJson.length > 0 ? asJson : parseDocumentSections(text, ctx.template.compiled);
            turnDegraded = true;
            return wholeDocumentAsTurn(parsed, ctx.template.compiled);
          },
          // TASK-939 — see the legacy branch: a well-formed whole-document response is usable via
          // the degrade path, so it must not trigger a second model call.
          shouldRepair: (first) =>
            first.structured && looksLikeJsonObject(first.text) && parseDocumentJson(first.text, ctx.template.compiled) === null,
        });

        const [firstCall, repairCall] = outcome.calls;
        textLatencyMs = firstCall.latencyMs;
        textStats = firstCall.stats;
        textRepaired = outcome.repaired;
        if (repairCall) {
          repairLatencyMs = repairCall.latencyMs;
          repairStats = repairCall.stats;
        }
        parsedSections = outcome.value.sections;
        turnWrites = outcome.value.writes;
        turnRefusals = outcome.value.refusals;
        return {
          text: buildRunningSummary(parsedSections),
          sections: parsedSections,
          stats: firstCall.stats,
          repaired: outcome.repaired,
        };
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
        runContext: ctx.runContext,
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

    // TASK-932 — a guard expression that could NOT be evaluated took `else`. Loud, because the
    // note a fallen-through condition produces is indistinguishable from the note the intended
    // branch would have produced: only this line says which one the clinician is reading.
    for (const evaluation of run.branchEvaluations) {
      if (evaluation.errors.length === 0) continue;
      this.logger.warn({
        message: 'Realtime branch guard could not be evaluated — the condition fell through to `else`',
        consultationId: session.consultationId,
        nodeId: evaluation.nodeId,
        handle: evaluation.handle,
        visitType: session.visitType ?? null,
        // PHI-safe: a branch KEY and the evaluator's own message. Never the context it read.
        errors: evaluation.errors,
      });
    }

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
    // TASK-932 — a `core.condition` split gives ONE capability several nodes, and all but the
    // taken one are `skipped`. Taking the first match would read the branch the graph routed
    // AROUND: on a revisit that is `n_summary_new`, whose skipped outcome carries no sections,
    // so the clinician would get an empty note while `n_summary_revisit` succeeded beside it.
    // Prefer the outcome that actually ran; fall back to the first so a lane in which every
    // node of a capability skipped still reports a skip, exactly as it did before.
    const ran = (capability: RealtimeCapabilityKey) =>
      run.outcomes.find((o) => ranAs(o, capability) && o.status !== 'skipped') ?? run.outcomes.find((o) => ranAs(o, capability));
    const summarize = ran('generateDocument');
    const extract = ran('extractEntities');
    const extractOutput = extract?.status === 'succeeded' ? extract.output : undefined;
    // Lane N — IMPORTANT FINDINGS. No handler produces this capability since the `core.*`
    // retirement removed `agent.important_findings`, so this stays empty until one does; the
    // lookup is kept keyed on the capability rather than deleted so wiring a handler is enough.
    const findingsNode = ran('extractFindings');
    const findingsOutput = findingsNode?.status === 'succeeded' ? findingsNode.output : undefined;
    const turnAgent = this.turnAgentIdentity(turnCandidates, textStats);

    return {
      sections: summarize?.status === 'succeeded' ? parsedSections : [],
      runningSummary: summarize?.status === 'succeeded' ? buildRunningSummary(parsedSections) : '',
      // TASK-939 — only the sections this turn changed. A node that did not succeed contributes no
      // writes, so a degraded generation can never be mistaken for "the turn had nothing to say".
      turnWrites: summarize?.status === 'succeeded' ? turnWrites : [],
      turnRefusals: summarize?.status === 'succeeded' ? turnRefusals : [],
      turnDegraded: summarize?.status === 'succeeded' ? turnDegraded : false,
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
      // A3 — the identity of the agent that ACTUALLY RAN this turn. Undefined when the node ran on
      // the session's assigned agent (no `core.agent` binding), where the frozen snapshot already
      // is the right answer.
      ...(turnAgent ? { turnAgent } : {}),
      run,
    };
  }

  /**
   * A3 — WHICH agent served this turn, as a provenance block.
   *
   * `stats.agent_slug` is stamped by `callTextCandidate` from the candidate it actually ran, so it
   * already distinguishes the primary from a fallback that took over after an outage. It is also
   * only a slug. This pairs it back with the resolved candidate to recover the version pin, so a
   * reader of `metadata.agent` gets the same identity `metadata.stats.agent_slug` names instead of
   * a second, contradicting one.
   *
   * Returns undefined — never a guess — when no candidate was bound, or when the served slug
   * matches none of them (a shape that should be impossible, and must not be papered over with
   * "probably the primary").
   */
  private turnAgentIdentity(
    candidates: readonly ResolvedTextCandidate[] | undefined,
    stats: LiveSummaryStatsDto | null,
  ): LiveSummaryAgentDto | undefined {
    if (!candidates || candidates.length === 0) return undefined;
    const served = stats?.agent_slug ? candidates.find((candidate) => candidate.agent.slug === stats.agent_slug) : candidates[0];
    if (!served) return undefined;
    return {
      // `versionId` IS the agent row id — agent rows ARE versions (see `ResolvedAgent.agentVersionId`).
      id: served.agent.versionId,
      // An agent has no display name distinct from its slug on this path; the slug is its real
      // name, not a placeholder standing in for one.
      name: served.agent.slug,
      slug: served.agent.slug,
      // For a `core.agent` the immutable prompt artifact is the AGENT VERSION, not a PromptVersion
      // row: the instruction bytes live on `compiledConfig`. So the pin reported here is that
      // version — which is what a reader has to re-resolve to see the prompt this turn ran.
      promptTemplateId: served.agent.versionId,
      promptVersionNumber: served.agent.versionNumber,
      resolvedFrom: 'agent',
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
      /**
       * TASK-939 — the per-section writes THIS turn implies, each carrying its own mode. Only these
       * sections are written and published: a section the turn said nothing about produces no
       * write, no row, no patch and no render churn, which is the whole point of the additive
       * contract.
       */
      writes: readonly TurnSectionWrite[];
    },
  ): Promise<Map<number, string>> {
    // TASK-939 R10 — sections whose AUTHORITATIVE body differs from what this flush produced,
    // keyed by render ordinal. Today that is exactly the clinician-CONFIRMED ones a replace was
    // refused on; the caller folds them back into the session's last-good note so the NEXT turn's
    // prompt shows the clinician's text instead of the machine's superseded version.
    const reconciled = new Map<number, string>();

    if (ctx.sections.length === 0) {
      await this.publishSectionDegrade(session, ctx.template, ctx.degradeReason);
      return reconciled;
    }
    // A turn that touched nothing publishes nothing — and is NOT a degrade: the note stands as it
    // was, which for a stretch of transcript with no clinical content is the correct outcome.
    if (ctx.writes.length === 0) return reconciled;

    // The document this lane is producing. One document today; the key is what
    // makes a second one addressable without reshaping anything.
    const documentKey = ctx.template.slug;
    const perSection = reanchorAnnotations(ctx.sections, ctx.runningSummary, ctx.entities, ctx.groundedness, ctx.findings);

    for (const write of ctx.writes) {
      const { sectionKey, idx } = write;
      try {
        const result = await this.sections().applyFlushPatch({
          consultationId: session.consultationId,
          tenantId: session.tenantId,
          documentKey,
          sectionKey,
          title: write.title,
          idx,
          content: write.content,
          mode: write.mode,
          // Annotations are computed over the POST-turn section list and indexed by the section's
          // render ordinal, so they are addressed by `idx` rather than by the write's position in
          // this loop — only changed sections are written, so the two are no longer the same.
          annotations: perSection[idx],
          ...(write.contradiction ? { contradiction: write.contradiction } : {}),
          documentTemplateVersionId: ctx.template.documentTemplateVersionId,
          generation: ctx.generation,
          userId: session.userId ?? null,
        });

        if (result.applied === true) {
          await this.safeChannelPublish(this.channel(session.consultationId), JSON.stringify(result.patch));
        } else if (result.reason !== 'unavailable') {
          // TASK-939 R10 — a CONFIRMED section hands back its real body so the next prompt is
          // built from what the clinician wrote.
          if (result.current !== undefined) reconciled.set(idx, result.current);
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

    return reconciled;
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
   * TASK-932 — the run context every `core.condition` guard on this lane is evaluated against.
   *
   * ## Why this shape, exactly
   *
   * `{ trigger, vars, nodes }` is the run context TASK-864 §3.2 declares and the harness builds
   * in `WorkflowInterpreter._run_context`, where `trigger` is the `core.trigger` node's published
   * `context` — which is the RUN PAYLOAD, and the consultation run payload is
   * `{ context: { visit_type, current_department, ... } }`. That is why the seeded branch reads
   * `trigger.context.visit_type` and not `trigger.visit_type`, and it is why the nesting below is
   * a fact about the durable contract rather than a choice made here.
   *
   * ## What it deliberately does NOT carry
   *
   * `vars` is `{}` and `nodes` is `{}`. This lane executes neither `core.variable` nor the
   * condition itself, so there is nothing honest to put in either; a guard reading them errors
   * and the condition takes `else` OBSERVABLY (`RealtimeRunResult.branchEvaluations`) instead of
   * being answered from a cache that was never filled. The durable lane, which does run those
   * nodes, remains the place a graph expresses a condition over them.
   *
   * Only the keys the gateway actually resolved are present: an ABSENT `visit_type` must read as
   * "the gateway does not know", which the evaluator reports as `no such key`, and never as a
   * substituted default that would route a follow-up visit down the new-visit branch in silence.
   */
  /**
   * TASK-943 — the run context the realtime lane evaluates guards against AND every `core.agent`
   * renders its instruction from (its `trigger` root, via `buildAgentPromptScope`).
   *
   * ## The defect this replaced
   *
   * This supplied exactly one variable, `visit_type`. The seeded `general-medicine-summarization`
   * agent binds NINE names to `trigger.context.*` (`seed/25-agents.ts`
   * `generalMedicinePromptVariables()`), and `core.agent` fails CLOSED on the first it cannot
   * resolve — correctly, because a clinical prompt carrying a literal `{{safe_age}}` is worse than
   * no note. So the realtime case note NEVER GENERATED: measured on a real 120 s recording, eight
   * flush generations produced eight `prompt_variable_unresolved` degrades and zero sections. It
   * also explains TASK-891's "`DocumentSection` holds 0 rows cluster-wide" better than that
   * ticket's own analysis did.
   *
   * ## Where each value comes from
   *
   * Six of the nine go through `buildPreSummaryVariables` — the SAME surface-neutral builder the
   * summary path uses — so the realtime and durable surfaces cannot drift on what an absent value
   * means. Its own rule is the one followed here: *"A surface that has no equivalent for a field
   * simply omits it and inherits v1's default — never a newly invented one."* The v2 data model
   * genuinely holds no patient demographics (`patientId` is an external reference with no local
   * demographic store), so `safe_age`/`safe_dob`/`safe_gender` resolve to the declared `Unknown`.
   *
   * The three names that builder does not carry are set here against the absence values the
   * workflow's OWN trigger-context schema declares for them
   * (`29-arcaai-agents-and-workflows.generated.ts`): `language` is the consultation language CODE
   * ("the v1 name of `language`"), `chief_complaint` is empty ("when the client supplies one"), and
   * `formatted_vitals` is `Not available` — UNLESS this session has extracted vitals of its own, in
   * which case they are reported. Claiming `Not available` while the session holds readings is a
   * falsehood, not a default.
   *
   * `formatted_previous_visits` stayed empty deliberately, and TASK-951 OD-5 ENDS that — see the
   * paragraph below.
   *
   * ## TASK-951 D-7 / OD-5 — what the CLIENT sent now reaches the prompt
   *
   * Two of these names had no source in the v2 data model when this method was written, and the
   * defaults above were the honest answer. They are no longer the honest answer: since TASK-951 a
   * client states `vitals` and `previous_case_notes` at `open`, HOPE validates them against the
   * tenant's own context schema and persists them as PRE context items, and this lane reads them.
   *
   *  - `formatted_vitals` prefers what the clinic MEASURED over what the session's NLP tool
   *    extracted from speech. The tool output is a model's reading of a conversation; the client's
   *    object is the reading itself, and where both exist the note should carry the measurement.
   *  - `formatted_previous_visits` is the client's history, newest first and bounded by the same
   *    cap the carried prior-visit summary uses. The old "empty by design" posture was a statement
   *    about the WARM-START pre-summary — feeding a previous NOTE into the next one is an input
   *    decision with clinical weight — and it is untouched: what is rendered here is material the
   *    client explicitly supplied AS prior-visit context, not something this lane went looking for.
   *
   * Absence is unchanged in every direction: no client kind, an unreadable one, or one that states
   * nothing all land on exactly the defaults documented above.
   */
  private async realtimeRunContext(session: LiveSession): Promise<Record<string, ExpressionValue>> {
    const client = await this.resolveClientContext(session);
    const clientVitals = formatClientVitalsForPrompt(client.vitals);

    const shared = buildPreSummaryVariables({
      currentDepartment: await this.resolveDepartmentName(session),
      visitType: session.visitType,
      language: session.summaryLanguage,
      // TASK-951 D-7 — the two the builder has always declared and this surface has never had a
      // source for. Passed THROUGH the builder rather than assigned after it, so `safe_vitals` and
      // `formatted_previous_visits` inherit v1's own `|| default` semantics instead of a second
      // copy of them, and an empty client history still reads as `''`.
      vitals: clientVitals,
      previousVisits: formatPreviousVisitsForPrompt(client.previousVisits),
    });

    const context: Record<string, ExpressionValue> = {
      ...shared,
      // The general-medicine template's own names for the three the pre-summary list spells
      // differently (`language_name`, `safe_vitals`) or does not carry (`chief_complaint`).
      language: (session.summaryLanguage ?? '').trim(),
      chief_complaint: '',
      formatted_vitals: clientVitals ?? formatVitalsForPrompt(session.lastPayload?.vitals) ?? shared.safe_vitals,
    };

    return { trigger: { context }, vars: {}, nodes: {} };
  }

  /**
   * TASK-951 D-7 — the client-supplied `vitals` / `previous_case_notes` for this session, resolved
   * at most ONCE and cached on it.
   *
   * Memoized through a promise rather than a boolean-plus-value, so two flushes racing the first
   * resolution share one read; the rows are written at `open` and cannot change for the life of
   * the consultation, which is what makes caching them correct rather than merely cheap.
   */
  private async resolveClientContext(session: LiveSession): Promise<LiveClientContext> {
    if (session.clientContext) return session.clientContext;
    if (!session.clientContextPromise) {
      session.clientContextPromise = this.readClientContext(session).then((resolved) => {
        session.clientContext = resolved;
        return resolved;
      });
    }
    return session.clientContextPromise;
  }

  /**
   * Read the two client-supplied kinds off the consultation's PRE context items. Never throws.
   *
   * Filtered by `kindKey` and NOT by `ContextItemType`: the kind key is what the tenant's schema
   * declares and what the writer stamps, and binding this read to a type as well would make it
   * disagree with the writer the moment either side chose a different enum member for the same
   * declared kind.
   *
   * A failure — no repository, an unreadable row, a body that will not decrypt, a payload that is
   * not the declared shape — degrades to "the client sent nothing", which is exactly the state
   * every consultation opened before this ticket is in. The alternative, raising, would stop a
   * note being produced over context that is by definition supplementary.
   */
  private async readClientContext(session: LiveSession): Promise<LiveClientContext> {
    const none: LiveClientContext = { previousVisits: [] };
    if (!this.contextItemRepository) return none;

    try {
      const items = await this.contextItemRepository.findByConsultation(session.consultationId);
      const [vitalsPayload, notesPayload] = await Promise.all([
        this.readClientKindPayload(latestContextItemOfKind(items, CLIENT_VITALS_KIND_KEY)),
        this.readClientKindPayload(latestContextItemOfKind(items, CLIENT_PREVIOUS_CASE_NOTES_KIND_KEY)),
      ]);

      const rawNotes = notesPayload?.notes;
      return {
        vitals: vitalsPayload ? (vitalsPayload as ClientVitalsPayload) : undefined,
        previousVisits: Array.isArray(rawNotes) ? (rawNotes.filter(isPlainRecord) as ClientPreviousCaseNote[]) : [],
      };
    } catch (error) {
      this.logger.warn({
        message: 'Client-supplied consultation context could not be read — the prompt keeps its declared defaults',
        consultationId: session.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return none;
    }
  }

  /**
   * One context item's body as the object it was persisted as, or `null`.
   *
   * `content` is Vault-Transit ciphertext at rest (the plaintext column was dropped), so a read
   * that skips the decrypt gets an empty body for a row that HAS one — the same defect
   * `findLatestPreSummaryWithDecryptedContent` exists to avoid. The transient `content` populated
   * by decrypt-on-read is the fallback for fixtures and for the no-secrets dev path, mirroring
   * `HarnessObservabilityService.decryptSummaryText`.
   */
  private async readClientKindPayload(entity: ContextItemEntity | null): Promise<Record<string, unknown> | null> {
    if (!entity) return null;

    let raw = entity.content ?? null;
    if (this.secretsService && this.contextItemRepository && entity.encryptedContent) {
      try {
        raw = await this.contextItemRepository.decryptContentFromEntity(entity, this.secretsService);
      } catch (error) {
        this.logger.warn({
          message: 'Client context item could not be decrypted — the prompt keeps its declared default for that kind',
          contextItemId: entity.id,
          kindKey: entity.kindKey,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }
    if (!raw?.trim()) return null;

    try {
      const parsed: unknown = JSON.parse(raw);
      return isPlainRecord(parsed) ? parsed : null;
    } catch {
      // A body that is not the JSON the kind declares is not a crash — PHI-safe: the key, never
      // the body.
      this.logger.warn({ message: 'Client context item is not a JSON object — ignored', contextItemId: entity.id, kindKey: entity.kindKey });
      return null;
    }
  }

  /**
   * The consultation's department NAME, resolved once per session.
   *
   * Cached on the session rather than re-read per flush: the id was already frozen off the row
   * `ensureSubstrateResolved` reads, and a name that cannot change mid-consultation has no business
   * costing a query every twenty seconds.
   *
   * Never throws — mirrors `PromptAssemblyService.resolveDepartmentName`. A failed lookup yields
   * `null` and the builder's documented default; a note must still be produced.
   */
  private async resolveDepartmentName(session: LiveSession): Promise<string | null> {
    if (session.departmentName !== undefined) return session.departmentName;
    session.departmentName = await this.departmentNameOf(session.departmentId ?? null);
    return session.departmentName;
  }

  /**
   * One department id → its NAME, or `null`. Never throws.
   *
   * Extracted from {@link resolveDepartmentName} by TASK-946 OD-3 so the live handoff resolves
   * `current_department` through the same read — the alternative was a second copy of "look it
   * up, swallow the failure, fall back to the builder's default", which is exactly how the two
   * surfaces would come to disagree about a department that cannot be read.
   */
  private async departmentNameOf(departmentId: string | null): Promise<string | null> {
    if (!departmentId || !this.departmentRepository) return null;
    try {
      const department = await this.departmentRepository.findById(departmentId);
      return department?.name ?? null;
    } catch (error) {
      this.logger.warn({
        message: 'Department lookup failed — `current_department` falls back to its declared default',
        departmentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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
   *
   * TASK-932 wave 4 added two things on top, both additive:
   *
   *   L-1 — the late join replays TWO cached documents, note snapshot first and then the last
   *   warm-start `presummary`, because they live under different keys and a warm start
   *   published before this stream subscribed is otherwise lost (measured: degraded at +29 ms,
   *   subscribe at +56 ms).
   *
   *   L-2 — the SSE frame TYPE is tagged from each payload's own `event`, so a consumer
   *   discriminates in the transport (`addEventListener('section.patch', …)`) rather than by
   *   parsing every message. The payloads are byte-identical, and the two kinds a legacy
   *   consumer actually folds — the snapshot and `closed` — carry no `event` and therefore stay
   *   on the default `message` type.
   */
  subscribeToLiveSummary(consultationId: string): Observable<MessageEvent> {
    return sseFromRedisChannel(this.redisSubscriber, this.logger, {
      channel: this.channel(consultationId),
      // TASK-940 — the last RESOLVED heartbeat. This call site is synchronous and
      // holds no tenant, so it reads the snapshot the most recent flush refreshed;
      // the descriptor documents that granularity rather than claiming per-flush.
      heartbeatMs: this.realtimeBudgets.heartbeatMs,
      loadSnapshot: () => this.loadLiveSummaryLateJoin(consultationId),
      isDuplicateOfSnapshot: (raw, _snapshot, emitted) => this.isDuplicateOfLiveSummarySnapshot(raw, emitted),
      // This channel is MULTIPLEXED, so the frame says which kind it carries: `section.patch` and
      // `presummary` become named SSE frames, and the undiscriminated whole-document snapshot and
      // its terminal `closed: true` stay on the default `message` type. The three harness relays
      // do not opt in, so they are untouched by construction.
      tagFrameTypeFromPayload: true,
      isTerminal: closedFlagTerminal,
      setupErrorPayload: JSON.stringify({ error: 'Failed to subscribe to live summary', consultationId }),
      logContext: { consultationId },
    });
  }

  /**
   * Everything a late joiner is owed, in RENDER order: the whole-document note snapshot first,
   * then the last warm-start `presummary` event.
   *
   * They live under two keys because they are two documents (see {@link preSummaryKey}), and the
   * order is the contract — the note is what the clinician is writing, the pre-summary is the
   * background material beside it. Either may be absent; absent entries are simply not emitted.
   */
  private async loadLiveSummaryLateJoin(consultationId: string): Promise<string[]> {
    const [snapshot, preSummary] = await Promise.all([
      this.cacheService.get(this.snapshotKey(consultationId)),
      this.cacheService.get(this.preSummaryKey(consultationId)),
    ]);
    return [snapshot, preSummary].filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  }

  /** The `updatedAt` of a serialized live-summary payload; null when absent/corrupt. */
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
   * The KIND of a serialized channel payload: its `event` discriminator, `''` for the
   * undiscriminated whole-document payload, `null` when it cannot be parsed at all.
   */
  private liveSummaryEventKind(raw: string | null | undefined): string | null {
    if (!raw) return null;
    try {
      const event = (JSON.parse(raw) as { event?: unknown }).event;
      return typeof event === 'string' ? event : '';
    } catch {
      return null;
    }
  }

  /**
   * True when a relayed channel event carries state an entry ALREADY EMITTED to this viewer
   * contained (same or older `updatedAt` — ISO strings compare lexicographically).
   *
   * Keyed on the event KIND, which is the whole point: three kinds share this channel (the
   * undiscriminated whole-document snapshot, `section.patch`, `presummary`) and their `updatedAt`
   * clocks are unrelated. Comparing a `presummary` against the NOTE snapshot's timestamp drops a
   * live warm-start event whenever the note happens to be as fresh — the warm-start panel going
   * dark again for exactly the reason L-1 exists to fix. Events with no `updatedAt`, and events
   * of a kind nothing was replayed for, are relayed untouched.
   *
   * The `presummary` kind uses BYTE IDENTITY instead of that timestamp comparison (L2 F-8). It is
   * not a document whose snapshot IS its state — it is a sequence of statuses (`running` →
   * `ready`/`degraded`) stamped from a MILLISECOND clock and cached before each publish, so a
   * successor separated only by a Redis round-trip routinely shares a millisecond with the event
   * a late joiner was replayed, and `<=` would swallow the terminal one: the panel spinning
   * forever on a warm start that already finished. The cached entry is a byte-identical copy of
   * what was published, which makes identity both the exact test for "this is the replay" and
   * the only one that cannot drop a newer event.
   */
  private isDuplicateOfLiveSummarySnapshot(raw: string, emitted: readonly string[]): boolean {
    const kind = this.liveSummaryEventKind(raw);
    if (kind === null) return false;
    const sameKind = emitted.find((entry) => this.liveSummaryEventKind(entry) === kind);
    if (sameKind === undefined) return false;
    if (kind === PRE_SUMMARY_EVENT) return raw === sameKind;
    const emittedUpdatedAt = this.parseLiveSummaryUpdatedAt(sameKind);
    if (!emittedUpdatedAt) return false;
    const updatedAt = this.parseLiveSummaryUpdatedAt(raw);
    return updatedAt != null && updatedAt <= emittedUpdatedAt;
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * The per-utterance metadata for `transcriptParts[from, to)`, with offsets into the string that
   * range JOINS to — which is what the capture node publishes, not the session transcript.
   *
   * The cursor walks EVERY part in the range while only TIMED parts are emitted, so the offsets
   * stay true to the joined text even when some utterance carried no timing. That case is a manual
   * `ingestSegment` (or a test); the STT bridge types `startTime`/`endTime` as required numbers, so
   * a live capture times every utterance. An untimed part contributes its words to `transcript`
   * and no entry here — deliberately, because the alternative is a segment claiming `start: 0`,
   * and a fabricated measurement is worse than a missing one.
   *
   * The join rule is `parts.join(' ')` with parts already trimmed and non-empty at ingest, so
   * `transcript.slice(charStart, charEnd) === segment.text` holds by construction rather than by
   * a text search that a repeated phrase could fool.
   */
  private buildGraphSegments(session: LiveSession, from: number, to: number): RealtimeTranscriptSegment[] {
    const built: RealtimeTranscriptSegment[] = [];
    let cursor = 0;
    for (let i = from; i < to; i++) {
      const part = session.transcriptParts[i];
      if (part === undefined) continue;
      if (i > from) cursor += 1; // the single space `join(' ')` puts before this part
      const charStart = cursor;
      cursor += part.length;

      const meta = session.transcriptSegments[i];
      if (meta?.startTime === undefined || meta.endTime === undefined) continue;

      built.push({
        text: part,
        start: meta.startTime,
        end: meta.endTime,
        charStart,
        charEnd: cursor,
        // Only finals reach `transcriptParts` (`ingestSegment` returns early on a partial), so
        // this is a statement of that invariant rather than a passthrough of the frame's flag.
        isFinal: true,
        ...(meta.speaker === undefined ? {} : { speaker: meta.speaker }),
        ...(meta.speakerConfidence === undefined ? {} : { speakerConfidence: meta.speakerConfidence }),
        ...(meta.utteranceIndex === undefined ? {} : { utteranceIndex: meta.utteranceIndex }),
        ...(meta.seq === undefined ? {} : { seq: meta.seq }),
        ...(meta.resultType === undefined ? {} : { resultType: meta.resultType }),
        ...(meta.stableChars === undefined ? {} : { stableChars: meta.stableChars }),
        ...(meta.language === undefined ? {} : { language: meta.language }),
        ...(meta.inferenceMs === undefined ? {} : { inferenceMs: meta.inferenceMs }),
        ...(meta.pipelineId === undefined ? {} : { pipelineId: meta.pipelineId }),
        ...(meta.receivedAtMs === undefined ? {} : { receivedAtMs: meta.receivedAtMs }),
        ...(meta.words === undefined ? {} : { words: meta.words }),
        // A5 — mic identity travels with the utterance it labels, so the capture node's published
        // segments (and through them the live handoff the durable finalizer binds) can attribute a
        // turn to a microphone.
        ...(meta.metadata === undefined ? {} : { metadata: meta.metadata }),
      });
    }
    return built;
  }

  private attachSttStream(session: LiveSession, sessionId: string): void {
    session.sttSubscription?.unsubscribe();
    session.sessionId = sessionId;
    if (!this.audioBridge) return;

    // The zero of the STT segment clock, as observed here. Stamped BEFORE the subscription so it
    // cannot be later than the first segment it has to anchor.
    session.sttStreamEpochMs = Date.now();

    try {
      session.sttSubscription = this.audioBridge.subscribeToResults(sessionId).subscribe({
        next: (msg) => {
          // The result stream now also carries non-transcript status frames
          // (provider_switched); narrow to transcripts before reading
          // transcript-only fields.
          if (msg?.type === 'transcript' && msg.isFinal && msg.text?.trim()) {
            // Forward the CORRELATION, not just the words. Every field below is already on the
            // frame (`SttTranscriptResult`); reading only `msg.text` here is what used to strand
            // the timing at the socket, so the transcript the graph lane published could not be
            // reconciled with the audio that produced it.
            this.ingestSegment(session.consultationId, {
              text: msg.text,
              isFinal: true,
              // The utterance ordinal IS the segment's identity on this stream, so use it as the
              // id rather than the `seg-N` counter `ingestSegment` falls back to — that counter is
              // this service's arrival order, which diverges from the producer's the moment a
              // frame is dropped or replayed.
              segmentId: msg.utteranceIndex !== undefined ? `utt-${msg.utteranceIndex}` : undefined,
              startTime: msg.startTime,
              endTime: msg.endTime,
              utteranceIndex: msg.utteranceIndex,
              // `speakerLabel` is the anonymous human-readable name the bridge derives once from
              // `speakerId`; `speakerId` is the raw diarization cluster. Prefer the label and fall
              // back to the id — carrying both would leave a consumer to guess which identifies.
              //
              // A5 — and, LAST, the client's own `metadata.speaker_label`. Strictly a fallback:
              // diarization is a measurement of the audio and the declaration is an assertion
              // about it, so the measurement wins wherever there is one. With ArcaAI's ASR agent
              // there never is — diarization is off — and without this the `speaker` field was
              // empty on every utterance of every consultation, which is why the finalizer had no
              // speaker turns to work from.
              speaker: msg.speakerLabel ?? msg.speakerId ?? declaredSpeakerLabel(msg.metadata),
              // A5 — the declaration itself, carried whole and uninterpreted. `speaker` above is
              // one reading of it; a consumer that wants the mic id (or anything else the tenant
              // declared) needs the object, not this service's opinion of it.
              metadata: msg.metadata,
              speakerConfidence: msg.speakerConfidence,
              // `detectedLanguage`, not the session's configured mode: this field exists to say
              // what was actually SPOKEN in this utterance, which is the whole point of it on a
              // code-switched capture. Absent for engines that do not detect.
              language: msg.detectedLanguage,
              resultType: msg.resultType,
              stableChars: msg.stableChars,
              pipelineId: msg.pipelineId,
              // `{ word, start, end, confidence }` on the wire; `text` here, matching the segment
              // schema. A null confidence (Whisper reports none) is dropped rather than coerced
              // to 0, which a consumer would read as "certainly wrong".
              words: msg.wordTimestamps?.map((w) => ({
                text: w.word,
                start: w.start,
                end: w.end,
                ...(w.confidence === null ? {} : { confidence: w.confidence }),
              })),
              receivedAtMs: Date.now(),
              // `seq` and `inferenceMs` are deliberately ABSENT, not forgotten: the bridge's
              // Redis projection (`projectAndEmitResult`) does not carry `inference_ms`, and the
              // monotonic transcript `seq` is assigned further downstream, by the WS gateway as it
              // forwards to a socket client. Neither is knowable here, and inventing one would put
              // a number in a field whose only purpose is to be trusted.
            });
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
    const delay = Math.max(0, this.lastAgenticContext.minIntervalMs - (Date.now() - session.lastFlushAt));
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
    const durableSnapshotMs = this.realtimeBudgets.durableSnapshotMs;
    if (!opts.force && (durableSnapshotMs <= 0 || Date.now() - session.lastDurableAt < durableSnapshotMs)) return;

    // A1 — the finalizer's input is a DOCUMENT, so write it as one.
    //
    // This row's `content` is what `harness.finalize` reads as `preSummaryText`
    // (`harness-internal.service.ts#loadLiveSoapSnapshot`). It used to be `payload.runningSummary`
    // — `buildRunningSummary(sections)`, an unlabelled `\n\n` join of the section BODIES — so the
    // finalizer was handed prose whose partition had been discarded and asked for a 13-section
    // note back. It answered with a narrative paragraph, every time.
    //
    // `buildStructuredSummary` is the same sections WITH their titles. Scoped to this ONE write on
    // purpose: `payload.runningSummary` is the NER offset base and the "section content is a
    // contiguous substring of runningSummary" invariant, and neither it nor any consumer of it is
    // touched. Falls back to the flat text when the flush produced no non-empty section (a resumed
    // or degraded note), so a snapshot is never LOST to the new rendering.
    const content = buildStructuredSummary(payload.sections ?? [], session.templateSnapshot?.compiled) || payload.runningSummary?.trim();
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

  /**
   * TASK-939 §2.2 — render the prior note for the PROMPT, with its structure intact.
   *
   * `buildRunningSummary` drops every title and key and returns a flat `\n\n` join of bodies. As
   * the prompt's "note so far" that was the defect's engine: the model was shown unlabelled prose
   * and asked for a keyed document, so it re-partitioned and re-emitted everything, every turn.
   * Feeding it back BY KEY means a turn can address one section without reconstructing the rest —
   * which is what makes the additive contract expressible at all.
   *
   * The key is named alongside the title because the turn schema is keyed: a model that reads
   * "Objective (objective)" knows which property to put its addition under.
   *
   * Empty sections are listed too, as `(nothing recorded yet)`. Omitting them invites the model to
   * treat the section as absent from the template rather than as not yet reached, and the compiled
   * schema requires every key regardless.
   */
  private renderPriorNote(sections: readonly LiveSummarySectionDto[], compiled: CompiledDocumentTemplate): string {
    if (sections.length === 0) return '';

    const titles = new Map(compiled.checklist.map((entry) => [entry.key, entry.title]));
    const keyByTitle = new Map(compiled.checklist.map((entry) => [entry.title.trim().toLowerCase(), entry.key]));
    const aligned = sections.length === compiled.sectionKeys.length;

    // Walk what we ACTUALLY HAVE, not the template's key list. The prose parser has a fallback
    // shape — one `Running Summary` section carrying the whole output when no heading matched — and
    // driving this off `sectionKeys` silently rendered every section as "(nothing recorded yet)" for
    // such a note, so the prior note vanished from the prompt and the model started over. Same
    // class of bug as re-keying the degrade path: the authoritative shape is the note, not the
    // template.
    const covered = new Set<string>();
    const rendered = sections.map((section, idx) => {
      const key = aligned ? compiled.sectionKeys[idx] : keyByTitle.get(section.title.trim().toLowerCase());
      if (key) covered.add(key);
      const body = (section.content ?? '').trim();
      // The key is named beside the title because the turn schema is KEYED: a model reading
      // "Objective (objective)" knows which property its addition belongs under. A section with no
      // resolvable key (the fallback) is rendered by title alone rather than mislabelled.
      const heading = key ? `## ${titles.get(key) ?? section.title} (${key})` : `## ${section.title}`;
      return `${heading}\n${body.length > 0 ? body : '(nothing recorded yet)'}`;
    });

    // Template sections the note has not reached are listed too. Omitting them invites the model to
    // treat a section as absent from the document rather than as not yet discussed, and the turn
    // schema requires every key regardless.
    for (const key of compiled.sectionKeys) {
      if (covered.has(key)) continue;
      rendered.push(`## ${titles.get(key) ?? key} (${key})\n(nothing recorded yet)`);
    }

    return rendered.join('\n\n');
  }

  /**
   * TASK-939 R7 — how many characters the clinician had ALREADY READ that this turn rewrote.
   *
   * For each section, if the new body still STARTS WITH the old one, nothing the reader had seen
   * changed and the churn is zero however much was added. Otherwise the whole prior body was
   * rewritten, and its length is what churned.
   *
   * Measured on the before/after NOTE rather than on the write list, deliberately: the write list is
   * this code's own claim about what it did, and a metric that reads it could never catch an append
   * path that silently replaced. The prefix test is the same invariant the accumulation test and the
   * replay harness assert, so one number means the same thing in all three.
   *
   * Sections are paired POSITIONALLY, which is how the whole realtime lane pairs them; a turn that
   * changed the section COUNT (the first turn of a session, or a degrade to the prose fallback) has
   * no comparable predecessor for the extra sections, so those contribute nothing.
   */
  private noteChurnChars(before: readonly LiveSummarySectionDto[], after: readonly LiveSummarySectionDto[]): number {
    let churn = 0;
    for (const [idx, priorSection] of before.entries()) {
      const prior = (priorSection.content ?? '').trim();
      if (prior.length === 0) continue;
      const next = (after[idx]?.content ?? '').trim();
      if (!next.startsWith(prior)) churn += prior.length;
    }
    return churn;
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
    // TASK-939 OD-2(a) — the turn contract's prose half (`turnInstruction`), already rendered.
    // Trailing and defaulted so every positional fixture keeps its arity. Empty ⇒ the pre-ticket
    // whole-document prompt, which is what the durable/compat callers still want.
    turnContract = '',
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
    // TASK-939 — under the turn contract the instruction is about the CONTRIBUTION, not about the
    // document: "update the existing note" invited the model to hand back the note, which is what
    // it did. `turnContract` (appended last) carries the field-level rules; this line only has to
    // say what the turn is FOR.
    const deltaInstruction = turnContract
      ? hasPriorNote
        ? `\n\nReport what the new transcript adds to the ${documentTitle} above. Do not reproduce the note.`
        : `\n\nThis is the first turn of this ${documentTitle}: report what the transcript above establishes.`
      : hasPriorNote
        ? `\n\nUpdate the existing ${documentTitle} above using ONLY the new transcript since the last update; keep prior content unless it is contradicted.`
        : `\n\nFrom the transcript and any clinician notes/labs above, produce the running ${documentTitle} now.`;

    // The frame goes LAST, after the delta instruction: it is the turn's procedure, and a
    // trailing block is what the model reads immediately before generating. It is deliberately
    // NOT part of `stablePrefix` — the prefix is byte-identical across every flush of a session
    // so the engine can reuse its cached KV, and the frame carries the same bytes for the same
    // session, so appending it here costs the cache nothing while keeping the prefix's contract
    // (tenant-governed prose + compiled structure) unmuddied.
    // `turnContract` is LAST of all — after the operating frame — because it is the output
    // contract, and the nearest instruction to the generation point is the one a model honours
    // most reliably. It is per-session-stable like the frame, so the prefix cache is unaffected.
    return stablePrefix + transcriptBlock + currentNoteBlock + elisionBlock + deltaInstruction + notesBlock + operatingFrame + turnContract;
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
      const [delta, threshold, idle, mode, budget, minInterval] = await Promise.all([
        this.effectiveSettings.resolveEffective(`${AGENTIC_CONTEXT_KEY_PREFIX}liveDelta.maxChars`, ctx),
        this.effectiveSettings.resolveEffective(`${AGENTIC_CONTEXT_KEY_PREFIX}liveFlush.segmentThreshold`, ctx),
        this.effectiveSettings.resolveEffective(`${AGENTIC_CONTEXT_KEY_PREFIX}liveFlush.idleMs`, ctx),
        this.effectiveSettings.resolveEffective(`${AGENTIC_CONTEXT_KEY_PREFIX}transcript.mode`, ctx),
        this.effectiveSettings.resolveEffective(`${AGENTIC_CONTEXT_KEY_PREFIX}tokenBudget.perRun`, ctx),
        this.effectiveSettings.resolveEffective(`${AGENTIC_CONTEXT_KEY_PREFIX}liveFlush.minIntervalMs`, ctx),
      ]);
      const resolved: AgenticContextKnobs = {
        liveDeltaMaxChars: storedNumber(delta) ?? fallback.liveDeltaMaxChars,
        segmentThreshold: storedNumber(threshold) ?? fallback.segmentThreshold,
        idleMs: storedNumber(idle) ?? fallback.idleMs,
        transcriptMode: storedMode(mode) ?? fallback.transcriptMode,
        tokenBudgetPerRun: storedNumber(budget) ?? fallback.tokenBudgetPerRun,
        minIntervalMs: storedNumber(minInterval) ?? fallback.minIntervalMs,
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
  /**
   * TASK-940 — the realtime budgets for THIS flush.
   *
   * Seven knobs that were `Number(configService.get('LIVE_DOC_…') ?? literal)` in
   * the constructor, so every one of them was a redeploy. Same contract and same
   * failure posture as {@link resolveTextTimeoutMs}: a stored row wins, env is an
   * override that loses to it, and an unresolvable read KEEPS THE PREVIOUS ANSWER
   * for this flush rather than lurching to a default mid-consultation.
   *
   * Resolved as one batch and assigned once, so a consumer can never observe a
   * half-updated set — `writeStats` reading a new TTL beside an old heartbeat
   * would be a state no registry write ever asked for.
   */
  async resolveRealtimeBudgets(tenantId: string): Promise<RealtimeBudgets> {
    const fallback = this.realtimeBudgetFallback();
    if (!this.effectiveSettings) {
      this.realtimeBudgets = fallback;
      return fallback;
    }
    const ctx = { tenantId };
    try {
      const [heartbeat, durable, statsTtl, maxTokens, gTimeout, gRetries, gBackoff] = await Promise.all([
        this.effectiveSettings.resolveEffective(CONSULTATION_REALTIME_HEARTBEAT_MS_KEY, ctx),
        this.effectiveSettings.resolveEffective(CONSULTATION_REALTIME_DURABLE_SNAPSHOT_MS_KEY, ctx),
        this.effectiveSettings.resolveEffective(CONSULTATION_REALTIME_STATS_TTL_SEC_KEY, ctx),
        this.effectiveSettings.resolveEffective(CONSULTATION_REALTIME_TEXT_MAX_TOKENS_KEY, ctx),
        this.effectiveSettings.resolveEffective(CONSULTATION_REALTIME_GROUNDEDNESS_TIMEOUT_MS_KEY, ctx),
        this.effectiveSettings.resolveEffective(CONSULTATION_REALTIME_GROUNDEDNESS_MAX_RETRIES_KEY, ctx),
        this.effectiveSettings.resolveEffective(CONSULTATION_REALTIME_GROUNDEDNESS_RETRY_BACKOFF_MS_KEY, ctx),
      ]);
      // `storedNumber` returns undefined for a `code-default` source, which is what
      // lets a kept env override win over the descriptor default without ever
      // beating a real stored row.
      this.realtimeBudgets = {
        heartbeatMs: storedNumber(heartbeat) ?? fallback.heartbeatMs,
        // 0 is MEANINGFUL here (it disables periodic durable writes), so this must
        // never be written as `|| fallback` — `??` is load-bearing.
        durableSnapshotMs: storedNumber(durable) ?? fallback.durableSnapshotMs,
        statsTtlSec: storedNumber(statsTtl) ?? fallback.statsTtlSec,
        textMaxTokens: storedNumber(maxTokens) ?? fallback.textMaxTokens,
        groundednessTimeoutMs: storedNumber(gTimeout) ?? fallback.groundednessTimeoutMs,
        groundednessMaxRetries: storedNumber(gRetries) ?? fallback.groundednessMaxRetries,
        groundednessRetryBackoffMs: storedNumber(gBackoff) ?? fallback.groundednessRetryBackoffMs,
      };
    } catch (error) {
      this.logger.warn({
        message: 'consultation.realtime.* budget resolution failed — keeping the previous values for this flush',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Push the three groundedness budgets into the object the tool registry holds
    // by identity. Done unconditionally, including on the catch path, so the
    // registry and this snapshot can never disagree about the current answer.
    this.groundednessToolBudgets.timeoutMs = this.realtimeBudgets.groundednessTimeoutMs;
    this.groundednessToolBudgets.maxRetries = this.realtimeBudgets.groundednessMaxRetries;
    this.groundednessToolBudgets.retryBackoffMs = this.realtimeBudgets.groundednessRetryBackoffMs;
    return this.realtimeBudgets;
  }

  /** env override (where one survives) → descriptor code default. */
  private realtimeBudgetFallback(): RealtimeBudgets {
    const env = this.envRealtimeBudgets;
    return {
      // `heartbeatMs` and `statsTtlSec` had their env names retired — nothing set
      // either one in any deployment OR any fixture — so the descriptor default IS
      // the pre-resolution value for them.
      heartbeatMs: CONSULTATION_REALTIME_DEFAULTS[CONSULTATION_REALTIME_HEARTBEAT_MS_KEY],
      statsTtlSec: CONSULTATION_REALTIME_DEFAULTS[CONSULTATION_REALTIME_STATS_TTL_SEC_KEY],
      // `??` is load-bearing: 0 is a MEANINGFUL value here (it disables periodic
      // durable writes) and a fixture relies on passing it, so `||` would silently
      // promote an explicit "never" to the 30 s default.
      durableSnapshotMs: env.durableSnapshotMs ?? CONSULTATION_REALTIME_DEFAULTS[CONSULTATION_REALTIME_DURABLE_SNAPSHOT_MS_KEY],
      textMaxTokens: env.textMaxTokens ?? CONSULTATION_REALTIME_DEFAULTS[CONSULTATION_REALTIME_TEXT_MAX_TOKENS_KEY],
      groundednessTimeoutMs: env.groundednessTimeoutMs ?? CONSULTATION_REALTIME_DEFAULTS[CONSULTATION_REALTIME_GROUNDEDNESS_TIMEOUT_MS_KEY],
      groundednessMaxRetries: env.groundednessMaxRetries ?? CONSULTATION_REALTIME_DEFAULTS[CONSULTATION_REALTIME_GROUNDEDNESS_MAX_RETRIES_KEY],
      groundednessRetryBackoffMs:
        env.groundednessRetryBackoffMs ?? CONSULTATION_REALTIME_DEFAULTS[CONSULTATION_REALTIME_GROUNDEDNESS_RETRY_BACKOFF_MS_KEY],
    };
  }

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
      minIntervalMs: this.envMinIntervalMs ?? AGENTIC_CONTEXT_DEFAULTS['liveFlush.minIntervalMs'],
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
    // TASK-958 F11 — a read-out of what an agent IS (task, schemas, parameters); it
    // spends nothing, so an unusable credential binding must not hide the agent.
    const resolved = await this.agentResolver.resolve({ tenantId, agentSlug: slug, primaryBinding: 'mark' });
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
    // TASK-943 — the run's `trigger` root, so an agent's `{ path: 'trigger.context.*' }` bindings
    // resolve instead of degrading the node. Trailing + optional, same reason as above.
    trigger?: Readonly<Record<string, unknown>> | null,
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
            trigger,
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
    // (`this.realtimeBudgets.textMaxTokens`), as it was before the split.
    // `resolveTextSelection` is the ONLY source of provider/model: selection belongs
    // to the tenant's assigned TEXT_GENERATION agent (TASK-876), never to an env
    // default. An unwired resolver leaves both undefined and TEXT applies its own
    // default — it must not silently fall back to a pinned engine (TASK-940).
    let provider: string | undefined;
    let model: string | undefined;
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
      max_tokens: this.realtimeBudgets.textMaxTokens,
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
    // TASK-943 — the run's `trigger` root, so an agent's `{ path: 'trigger.context.*' }` bindings
    // resolve. Trailing + optional so every positional fixture keeps its arity; ABSENT ⇒ the
    // pre-943 behaviour (no trigger root), which is correct for a caller that genuinely has none.
    trigger?: Readonly<Record<string, unknown>> | null,
  ): Promise<{ text: string; stats: LiveSummaryStatsDto | null; structured: boolean }> {
    const includeResponseFormat = candidate.provider.toLowerCase() !== 'ollama';
    const generation = { ...asRecord(candidate.parameters.generation), ...overrides.generation };
    const instruction = asRecord(candidate.instruction);
    const variables = { ...asRecord(instruction.variables), ...overrides.promptVariables };
    // TASK-947 §4.1 — ONE render seam for all three instruction forms. `composed` is `null` only
    // when the candidate carries no instruction body at all, which is the pre-947 `LIVE_DOCUMENT_
    // SYSTEM_PROMPT` case.
    const promptSource = liveCandidatePromptSource(candidate.resolvedPrompt, instruction);
    const composed = promptSource ? renderLivePrompt(promptSource, variables, candidate.agent.slug, trigger, candidate.contextSchema) : null;
    if (composed && composed.excluded.length > 0) {
      // OD-11 — KEY + REASON only. A `when` and a fragment body are authored clinical text; the
      // point of naming the exclusions at all is that an author can tell "the branch was false"
      // from "the branch could not be read", and both fit in the reason.
      this.logger.debug({
        message: 'core.agent: prompt fragments excluded from this generation',
        agentSlug: candidate.agent.slug,
        excluded: composed.excluded.map(({ key, reason }) => ({ key, reason })),
      });
    }
    // Selected KEYS, and only for a composite: a single-body agent has no fragments to report, and
    // `[]` there would read as "every fragment was excluded".
    const promptFragments = promptSource?.source === 'composite' && composed ? [...composed.selected] : null;
    // TASK-876 — the RESOLVED candidate's own credential is authoritative for this request.
    // Without it `postTextGenerate`'s enrichment recomputes `provider_overrides` from the CLS
    // tenant, so a call served by the SYSTEM platform default would be forwarded with the
    // TENANT's key and metered `funding: 'tenant'` — the opposite of the tier that actually
    // served, and of `candidate.fundingTier` stamped on the stats one block below.
    const { provider: _overrideProvider, ...overrideEntry } = candidate.providerOverride ?? {};
    const payload = {
      prompt: corrective ? `${promptText}${corrective}` : promptText,
      system_prompt: composed?.prompt ?? LIVE_DOCUMENT_SYSTEM_PROMPT,
      provider: candidate.provider,
      model: candidate.model,
      temperature: numberOrUndefined(generation.temperature),
      max_tokens: numberOrUndefined(generation.maxTokens) ?? this.realtimeBudgets.textMaxTokens,
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
            prompt_fragments: promptFragments,
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
    const ledger = this.usageLedger;
    // TASK-890 §3.14 record (a) — a `core.agent` node stamps the DISPOSITION beside the trigger,
    // so "this consultation ran without its guard" is a query, not an inference from graph JSON.
    // The disposition read is async (it consults the PLATFORM kill switch, which outranks the
    // node's opinion), so it is folded inside the same fire-and-forget chain the row already
    // used. A legacy flush passes no decision and stamps no key, exactly as before.
    // TASK-959 — the device resolution and the batch build BOTH moved inside this chain. The
    // device decides the compute UNIT, is resolved from configuration keyed by the provider that
    // actually served, and that read is asynchronous — while `recordLlmUsage` is fire-and-forget
    // by contract, because the note is already on its way to the clinician. So the build joins
    // the same swallowed chain: a resolver or ledger outage costs a row, never a note.
    const record = async (): Promise<void> => {
      const pair = buildLlmUsageBatches({
        usage,
        tenantId,
        operation: 'generate',
        consultationId: consultationId ?? null,
        device: await this.llmDevice(tenantId, usage),
      });
      const disposition = guardrail && this.textRequestEnrichment ? await this.textRequestEnrichment.guardrailDisposition(guardrail) : undefined;
      for (const input of usageBatches(pair, { trigger: 'CONSULTATION', ...(disposition ? { guardrail: disposition } : {}) })) {
        await ledger.recordUsage(input);
      }
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

  /**
   * Which device this generation's seconds were spent on — `null` when this lane has no business
   * naming one (TASK-959 §3.1).
   *
   * A CLOUD or BYOK call is not the vendor's hardware: those seconds are the platform's own CPU
   * spent CALLING the vendor, which the appender meters as `cpu` whatever is passed. The provider
   * comes off TEXT's OWN usage block — the engine that actually served, which on this lane may be
   * a fallback candidate rather than the primary the resolver picked.
   *
   * Never raises: an unresolvable device costs a compute row, and losing the whole batch — tokens
   * included — to protect a device label is the expensive direction to be wrong in.
   */
  private async llmDevice(tenantId: string, usage: TextUsageDetail): Promise<ComputeDevice | null> {
    const provider = toLedgerProvider(usage.textProvider);
    if (resolveDeployment(provider, usage.byok) !== AiDeploymentKind.SELF_HOSTED) return null;
    try {
      return (await this.computeDevice?.resolve(tenantId, provider)) ?? null;
    } catch (error) {
      this.logger.warn({
        message: 'Compute device unresolved; metering this live generation without a compute row',
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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
    let provider: string | undefined;
    let model: string | undefined;
    let generation: unknown;
    if (this.harnessPolicyService) ({ provider, model, generation } = await this.harnessPolicyService.resolveTextSelection(tenantId, 'live'));

    const payload = {
      // The entity spans are DETECTOR HINTS: they tell the model where a clinical term was found
      // so it proposes over those spans rather than over ordinary prose.
      prompt: JSON.stringify({ text: sourceText, entities: entities.map((e) => ({ start: e.start, end: e.end, text: e.text, type: e.type })) }),
      system_prompt: systemPrompt,
      provider,
      model,
      max_tokens: this.realtimeBudgets.textMaxTokens,
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
    let provider: string | undefined;
    let model: string | undefined;
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
      max_tokens: this.realtimeBudgets.textMaxTokens,
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
  /**
   * A2 — rebase a flush's RAW NER offsets onto the UTTERANCE that produced them.
   *
   * ## What comes in, and why it cannot be published as it stands
   *
   * `transcriptStart`/`transcriptEnd` (live-tool-registry) index `nerSourceText` — the per-flush
   * transcript DELTA. That string is internal: it is a window whose bounds move every turn and
   * which no consumer ever receives. An offset into it is not an anchor, it is a coincidence.
   *
   * ## What goes out
   *
   * `session.pendingGraphSegments` describes exactly that same string as `[charStart, charEnd)`
   * ranges per utterance, built from the same range in the same order (`buildGraphSegments`), so
   * the segment CONTAINING an entity is a lookup rather than a text search a repeated phrase could
   * fool. The entity then carries the segment's own id (`utt-<utteranceIndex>`, which is what
   * `ingestSegment` stamps and what the downlink `utteranceIndex` equals) and offsets into THAT
   * segment's text — stable for as long as the utterance exists, which is the property a
   * "jump to transcript" citation needs and a delta offset never had.
   *
   * ## When it refuses
   *
   * All three fields are dropped — never partially kept, never guessed — when the entity cannot be
   * tied to one timed utterance:
   *  - the producer sent no offsets at all (a findings node, a manual entity);
   *  - the span falls in an UNTIMED part, which `buildGraphSegments` omits by construction rather
   *     than claim a fabricated `start: 0` for;
   *  - the span STRADDLES two utterances, where a clamped offset would silently cite text the
   *     entity was not extracted from (the same rule `reanchorAnnotations#localSpan` applies).
   *
   * A dropped anchor costs a console its "jump to transcript" link for that entity; a wrong one
   * costs it the clinician's trust in every link.
   */
  private anchorEntitiesToTranscript(
    entities: readonly LiveSummaryEntityDto[],
    segments: readonly RealtimeTranscriptSegment[] | undefined,
  ): LiveSummaryEntityDto[] {
    return entities.map((entity) => {
      // Stripped up front so a refusal below can never leave a delta-relative number behind, and
      // so a producer cannot smuggle in a `transcriptSegmentId` this pass did not verify.
      const { transcriptSegmentId: _claimed, transcriptStart, transcriptEnd, ...rest } = entity;
      if (typeof transcriptStart !== 'number' || typeof transcriptEnd !== 'number') return rest;

      const segment = segments?.find((candidate) => transcriptStart >= candidate.charStart && transcriptStart < candidate.charEnd);
      if (!segment || segment.utteranceIndex === undefined) return rest;
      if (transcriptEnd > segment.charEnd) return rest;

      return {
        ...rest,
        transcriptSegmentId: `utt-${segment.utteranceIndex}`,
        transcriptStart: transcriptStart - segment.charStart,
        transcriptEnd: transcriptEnd - segment.charStart,
      };
    });
  }

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
   * The last `presummary` event, cached for late join beside — never inside — the whole-document
   * snapshot. Two keys because they are two different documents: `…:last` is the clinician's
   * running note, this is the warm-start material that precedes it.
   */
  private preSummaryKey(consultationId: string): string {
    return `${this.CHANNEL_PREFIX}${consultationId}:presummary:last`;
  }

  // ------------------------------------------------------------------
  // TASK-932 R-16a — the LIVE HANDOFF
  //
  // The durable interpreter skips every `realtime` node of a consultation-bound run so exactly
  // one runtime executes it (`_has_live_owner`). That is right, and it left the durable half
  // with nothing to bind: `n_finalize` — the seeded `casenote-finalization` agent, `execution:
  // { lane: durable, cadence: onEnd }` — resolved `bound_inputs: {}` and degraded
  // "core.agent: nothing bound on `in`/`context` to generate from" on every consultation the
  // platform has ever run. These three methods are the bridge.
  // ------------------------------------------------------------------

  /** Where one consultation's handoff record lives. */
  private handoffKey(consultationId: string): string {
    return `${this.HANDOFF_PREFIX}${consultationId}`;
  }

  /**
   * Fold ONE flush's successful node outputs into the session's accumulated set.
   *
   * Pure bookkeeping, deliberately: no I/O, no publish, nothing that can fail a flush. A node
   * that degraded this flush contributes nothing and does NOT erase what it produced earlier —
   * the finalizer wants the best the live lane reached, not the tail of it.
   */
  private captureLiveNodeOutputs(session: LiveSession, run: RealtimeRunResult): void {
    if (run.outputs.size === 0) return;
    const accumulated = session.liveNodeOutputs ?? (session.liveNodeOutputs = {});
    for (const [nodeId, output] of run.outputs) {
      accumulated[nodeId] = output;
    }
  }

  /**
   * Write the session's accumulated live outputs where the durable run can read them.
   *
   * Called from `stop()` BEFORE `teardownLocal`, which is the only moment both facts are true:
   * the session still holds its outputs, and no further flush will add to them.
   *
   * A write failure is logged at ERROR, not swallowed quietly and not thrown. Not thrown,
   * because a clinician pressing stop must always get their recording stopped; at ERROR,
   * because the consequence is a consultation whose note never finalizes — the interpreter
   * keeps answering "not ended yet" until its own bound expires and then degrades with a named
   * reason. That is a visible, recoverable failure, and it deserves to be visible.
   *
   * A session that produced NOTHING still writes a record. "The live lane ran and produced
   * nothing" and "the live lane has not handed off yet" are different states and the durable
   * poll waits on exactly that difference; conflating them would park the run for two hours on
   * a consultation that was simply silent.
   */
  private async persistLiveHandoff(session: LiveSession): Promise<void> {
    const record: LiveHandoffRecord = {
      endedAt: new Date().toISOString(),
      tenantId: session.tenantId,
      outputs: session.liveNodeOutputs ?? {},
    };
    try {
      await this.cacheService.setex(this.handoffKey(session.consultationId), this.HANDOFF_TTL, JSON.stringify(record));
    } catch (error) {
      this.logger.error({
        message:
          'Live handoff could not be written — the durable run will not be able to bind this consultation’s note and its finalize will degrade',
        consultationId: session.consultationId,
        // PHI-safe: node ids and a count, never the note.
        nodeIds: Object.keys(record.outputs),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * TASK-932 R-16a — the durable interpreter's read of this consultation's live handoff.
   *
   * Answers three states, and the distinction between the last two is the whole contract:
   *
   *  * **not ended** — a handoff record has not been written and the consultation can still
   *    produce one (it is `OPEN` / `PRIMED` / `RECORDING` / `REOPENED`). The caller polls.
   *  * **ended with outputs** — the live lane handed off. `outputs` is filtered to the node ids
   *    the caller asked about, so a graph is never told about a lane it does not have.
   *  * **ended with nothing** — a consultation that never recorded, or one whose lifecycle has
   *    moved past capture without a record (a stop routed to an instance that owned no session,
   *    or a Redis eviction). Empty is reported honestly; the finalizer then degrades with its
   *    own named reason rather than being handed a fabricated note.
   *
   * `context` is resolved HERE, once, and only when the handoff has actually ended: the
   * clinician's effective DNA writing style, gated by the tenant AND doctor toggles the
   * doctor-facing reads use. Resolving it here rather than stamping it into the run payload at
   * dispatch is deliberate — it means the style cannot be supplied, or spoofed, by a caller.
   */
  async readLiveHandoff(consultationId: string, nodeIds: readonly string[] = []): Promise<LiveHandoffResponse> {
    const record = await this.readLiveHandoffRecord(consultationId);
    const consultation = await this.loadConsultationForHandoff(consultationId);
    // Capture is over the moment the consultation leaves the states that can still produce it.
    // `DRAINING` counts as ended on purpose: it means capture stopped, so nothing more is
    // coming, and a run must not wait two hours for a record that a non-owner stop never wrote.
    const stillLive = consultation !== null && LIVE_CAPTURE_STATUSES.has(String(consultation.status ?? ''));
    if (!record && stillLive) return { ended: false, outputs: {}, context: {} };

    const requested = new Set(nodeIds);
    const outputs = Object.fromEntries(Object.entries(record?.outputs ?? {}).filter(([nodeId]) => requested.size === 0 || requested.has(nodeId)));
    return {
      ended: true,
      ...(record ? { endedAt: record.endedAt } : {}),
      outputs,
      context: await this.resolveHandoffContext(consultation),
    };
  }

  /** The stored record, or `null` (absent, evicted, or unparseable — all "no handoff yet"). */
  private async readLiveHandoffRecord(consultationId: string): Promise<LiveHandoffRecord | null> {
    try {
      const raw = await this.cacheService.get(this.handoffKey(consultationId));
      if (!raw) return null;
      const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as LiveHandoffRecord;
      return parsed && typeof parsed.outputs === 'object' && parsed.outputs !== null ? parsed : null;
    } catch (error) {
      this.logger.warn({
        message: 'Live handoff record could not be read — reporting no handoff',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** The consultation row, or `null` when it cannot be read (no repository, or a bad id). */
  private async loadConsultationForHandoff(consultationId: string): Promise<ConsultationEntity | null> {
    if (!this.consultationRepository) return null;
    try {
      return (await this.consultationRepository.findById(consultationId)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The clinician's EFFECTIVE DNA additions to the run context: the writing STYLE and the
   * REDACTION rules, each admitted by its OWN gate, from ONE report and ONE decrypt.
   *
   * ## Two gates, not one (L2 F-2)
   *
   * `resolveEffectiveDnaStyleEnabled` and `resolveEffectiveDnaRedactionEnabled` answer different
   * questions — an active `agent.dna_style` node vs an active `agent.dna_redaction` node (either
   * satisfied by a `core.agent` that `declaresDna`), and only the redaction node can waive the
   * doctor's opt-in with `requireDoctorOptIn: false`. Gating both halves on the STYLE switch
   * therefore diverged three ways, and the two that matter are UNDER-application: a tenant that
   * declares redaction but not style, and a doctor whose report carries rules but no style text
   * (the old `if (!text) return {}`), both shipped no rules — a note the clinician expected
   * redacted finalizing unredacted, with no FLAG, because `apply_redaction` never ran.
   *
   * The halves are otherwise independent: a style with no rules, rules with no style, both, or
   * neither are all legitimate answers, and the report is read only when at least one gate
   * admits something (PHI is not decrypted to be thrown away).
   *
   * ## What `{}` means
   *
   * `{}` — never a partial or a placeholder — whenever DNA does not apply at all: no
   * consultation, no doctor, no report, both gates off, or an unwired secrets backend. The
   * seeded finalize instruction reads `{{context.dna_style_text | default("")}}`, so an absent
   * style renders as plain clinical prose, which is exactly what "this clinician has no style on
   * file" should produce.
   *
   * A THROWN gate or a failed decrypt is the one case where the halves are not independent: it
   * costs the WHOLE context. That is the fail-closed posture both resolvers document — nothing
   * rides a governance read that did not complete.
   *
   * ## TASK-946 OD-3 — the CLINICAL half, which was missing entirely
   *
   * The durable interpreter builds its `trigger.context` from this object, and the seeded
   * `n_visit` condition compares `trigger.context.visit_type`. This method published only the
   * DNA keys — and `{}` outright whenever DNA did not apply — so the condition evaluated against
   * an absent variable and every one of the eleven published ArcaAI graphs took `else` on the
   * durable lane, documenting every revisit as a first visit. The clinical keys are therefore
   * ALWAYS present once the consultation row is readable, and the DNA half layers on top exactly
   * as it did before: absent means absent, never a placeholder.
   */
  private async resolveHandoffContext(consultation: ConsultationEntity | null): Promise<Record<string, unknown>> {
    if (!consultation) return {};
    return { ...(await this.handoffClinicalContext(consultation)), ...(await this.resolveHandoffDnaContext(consultation)) };
  }

  /**
   * TASK-946 OD-3 — the clinical half of the handoff context.
   *
   * Built from the CONSULTATION ROW, not from the live session, because by the time the durable
   * interpreter reads the handoff the session has been torn down by `stop()`. That costs nothing
   * in fidelity: the row is the very source `ensureSubstrateResolved` freezes
   * `visitType` / `summaryLanguage` / `departmentId` from, so the two lanes read one fact.
   *
   * Values come from `buildPreSummaryVariables` — the same surface-neutral builder
   * `realtimeRunContext` uses — so a field the platform has no value for inherits v1's declared
   * default rather than a newly invented one, and the two lanes cannot drift on what an absent
   * value means. `visit_type` is therefore the catalogue KEY (`new-visit` / `revisit`), which is
   * the enum the seeded CEL compares; `language` is the consultation's declared language CODE
   * beside the builder's `language_name`, exactly as the realtime context spells the pair.
   *
   * `chief_complaint` and `formatted_vitals` are deliberately NOT published: the first is an
   * empty-string placeholder the workflow's own trigger-context schema already defaults, and the
   * second is this recording's extracted vitals — session state that no longer exists here, so
   * any value would be stale or invented.
   */
  private async handoffClinicalContext(consultation: ConsultationEntity): Promise<Record<string, unknown>> {
    const language = readSummaryLanguage(consultation.metadata);
    const shared = buildPreSummaryVariables({
      currentDepartment: await this.departmentNameOf(consultation.departmentId ?? null),
      // Derived exactly as `ensureSubstrateResolved` derives the session's own copy — TASK-951 D-3
      // included, so the value the durable lane's `n_visit` condition compares is the one the
      // realtime lane branched on. Reading the same row through the same two inputs is what keeps
      // the two lanes from disagreeing about which visit this is. `forConsultation` is pure.
      visitType: DEFAULT_VISIT_TYPE_SERVICE.forConsultation(consultation.tenantId, {
        isFollowUp: Boolean(consultation.parentConsultationId),
        recorded: readRecordedVisitType(consultation.metadata),
      }).key,
      language,
    });
    return { ...shared, language: (language ?? '').trim() };
  }

  /** The DNA half — unchanged from before OD-3, including its `{}` on every non-applying state. */
  private async resolveHandoffDnaContext(consultation: ConsultationEntity | null): Promise<Record<string, unknown>> {
    const doctorId = consultation?.doctorId;
    if (!consultation || !doctorId || !this.dnaReportRepository || !this.secretsService) return {};
    try {
      const gateContext = { tenantId: consultation.tenantId, departmentId: consultation.departmentId ?? null, doctorId };
      // An unwired resolver is a COMPOSITION fact (the positional constructions in background
      // processors and legacy tests), not a degraded read, and it gates nothing — exactly as it
      // did for the style before this method learned the second gate.
      const [styleEnabled, redactionEnabled] = this.configResolver
        ? await Promise.all([
            this.configResolver.resolveEffectiveDnaStyleEnabled(gateContext).then((gate) => gate.effective),
            this.configResolver.resolveEffectiveDnaRedactionEnabled(gateContext).then((gate) => gate.effective),
          ])
        : [true, true];
      if (!styleEnabled && !redactionEnabled) return {};

      const report = await this.dnaReportRepository.findLatestForDoctor(doctorId);
      if (!report) return {};
      // ONE decrypt, two fields: the writing style and the doctor's redaction/rewrite rules are
      // stored on the same report, so both gates are answered by a single read.
      const { styleText, redactionRules } = await this.dnaReportRepository.decryptFieldsFromEntity(report, this.secretsService);
      const text = styleEnabled ? styleText?.trim() : undefined;
      const rules = redactionEnabled ? this.readHandoffRedactionRules(redactionRules, consultation.id) : [];
      return {
        // `dna_style_id` travels beside the text so the persisted `SummaryMeta.dnaWritingStyleId`
        // names the report that actually SHAPED the note — which is why it is part of the style
        // half and absent when nothing shaped it, not a general provenance stamp.
        ...(text ? { dna_style_text: text, dna_style_id: report.id } : {}),
        // ABSENT, never `[]`: the interpreter's finalize runs `apply_redaction` only when the
        // context carries rules, and an empty array would ask it to do nothing at some cost.
        ...(rules.length > 0 ? { dna_redaction_rules: rules } : {}),
      };
    } catch (error) {
      this.logger.warn({
        message: 'Effective DNA style/redaction could not be resolved for the live handoff — finalizing without either',
        consultationId: consultation.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  /**
   * The doctor's redaction/rewrite rules, from the SAME decrypted report the writing style came
   * from, validated to the persisted `{ rules: [...] }` shape.
   *
   * Rule OBJECTS, not strings: the harness's `RedactionRule` is `extra="forbid"` over
   * `{ id, type, match, pattern, replacement?, note? }`, so that is what has to arrive.
   *
   * `[]` on absent or malformed, which mirrors `resolveRedactionRulesForHarness`'s documented
   * fail-SAFE on the legacy path: an unusable rule set must not cost the note the STYLE it would
   * otherwise have carried, and `apply_redaction` is the fail-CLOSED-to-FLAG authority once rules
   * are actually present.
   */
  private readHandoffRedactionRules(redactionRules: unknown, consultationId: string): Record<string, unknown>[] {
    if (!redactionRules) return [];
    try {
      return validateRedactionRuleSet(redactionRules).rules as unknown as Record<string, unknown>[];
    } catch (error) {
      this.logger.warn({
        message: 'DNA redaction rules could not be read for the live handoff — finalizing without them (the writing style is unaffected)',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
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
      /** TASK-939 R7 — the accumulation metrics. See `LiveDocSessionStatsResponse` for what each means. */
      noteChurnChars: number;
      turnSectionsAppended: number;
      turnSectionsRewritten: number;
      turnRefusedRewrites: number;
      turnDegraded: boolean;
      /** TASK-946 D6 — this flush produced no note. See `LiveDocSessionStatsResponse`. */
      flushFailed: boolean;
      /** TASK-946 D6 — the PHI-safe code from `degrade-codes.ts`; absent on a healthy flush. */
      degradeReason?: string;
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
      noteChurnChars: metrics.noteChurnChars,
      turnSectionsAppended: metrics.turnSectionsAppended,
      turnSectionsRewritten: metrics.turnSectionsRewritten,
      turnRefusedRewrites: metrics.turnRefusedRewrites,
      turnDegraded: metrics.turnDegraded,
      flushFailed: metrics.flushFailed,
      // Absent, never `''`: a reason exists exactly when something went wrong.
      ...(metrics.degradeReason ? { degradeReason: metrics.degradeReason } : {}),
      // Omitted entirely when nothing degraded, so a healthy session's snapshot keeps the
      // shape it had before B4.
      ...(metrics.nodeDegrades && metrics.nodeDegrades.length > 0 ? { nodeDegrades: metrics.nodeDegrades } : {}),
    };

    try {
      await this.cacheService.setex(this.statsKey(session.consultationId), this.realtimeBudgets.statsTtlSec, JSON.stringify(snapshot));
      await this.cacheService.sadd(this.activeSetKey(session.tenantId), session.consultationId);
      // Backstop crash cleanup: a fully-dead tenant set expires on its own.
      await this.cacheService.expire(this.activeSetKey(session.tenantId), this.realtimeBudgets.statsTtlSec);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to publish live-doc session stats',
        consultationId: session.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Drop the pre-summary late-join replay at the end of a session.
   *
   * Best-effort, like every other teardown write here: failing to clear a transient replay key
   * must never fail the clinician's stop. The worst case if it does is what the TTL already
   * bounds — one stale replay, for at most an hour.
   */
  private async clearPreSummary(consultationId: string): Promise<void> {
    try {
      await this.cacheService.del(this.preSummaryKey(consultationId));
    } catch (error) {
      this.logger.warn({
        message: 'Failed to clear the pre-summary replay key on stop',
        consultationId,
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

/**
 * Both halves of an augmented pair (TASK-959 §6.3), each carrying the same stamped dimensions —
 * the platform CPU leg of a BYOK call is the same product activity, screened the same way, as
 * the tokens beside it. A non-BYOK pair flattens to the one batch it always was.
 */
function usageBatches(pair: ComputeAugmentedBatch | null, attributes: UsageAttributes): UsageEventBatchInput[] {
  if (!pair) return [];
  const halves = pair.platformBatch ? [pair.batch, pair.platformBatch] : [pair.batch];
  return halves.map((batch) => withUsageAttributes(batch, attributes) ?? batch);
}
