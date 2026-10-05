import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TranscriptionJobRepository, TranscriptionJobType } from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { frozenTriggerPayloadSchema } from '../consultation-context-schema/context-schema-usages';
import { isMediaReferenceSchema } from '../consultation-context-schema/context-schema-definition';
import { WORKFLOW_RUNS_DEFAULTS, WORKFLOW_RUNS_LIVE_AUDIO_MAX_SECONDS_KEY } from '../settings-registry/descriptors/workflow-runs.descriptors';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { GoverningWorkflowAsrReader } from '../stt/agent-resolver/governing-workflow-asr';
import { effectiveExposureSettings, isWorkflowEntryAllowed } from '../workflow-definition/exposure-settings';
// Leaf module, not the `../workflow-run` barrel: a DI class token (see workflow-exposure.service.ts).
import { RUN_STARTED_BY_KEY, RunPrincipalAccessService, readRunStartedBy, sameRunPrincipal, type RunPrincipal } from '../workflow-run/run-principal-access';
import type { StartWorkflowRunLiveAudio } from '../consultation/harness/harness-gateway.service';

/**
 * TASK-1042 — binding a live STT session to a STANDALONE workflow run (OD-1 option B).
 *
 * An integrator opens an STT streaming session, then starts the run with
 * `input[<audioField>] = { sttSessionId }`, where `<audioField>` is the ONE Input key whose frozen
 * trigger schema is the stream-audio payload (C2). This service decides whether that session may
 * feed that run, and records the binding on the session's `TranscriptionJob` row:
 *
 * | Order | Check | Refusal |
 * |---|---|---|
 * | 1 | `sttSessionId` only on a declared stream-audio key, on at most one | 400 `RUN_AUDIO_INPUT_UNDECLARED` / `RUN_AUDIO_MULTIPLE` |
 * | 2 | the workflow's settings admit `socket` (a legacy definition has none) | 400 `LIVE_AUDIO_UNSUPPORTED` |
 * | 3 | the session is a STREAMING job of this tenant, opened by the SAME principal (C8) | house 404, the body of an unknown session |
 * | 4 | the session is live | 409 `RUN_AUDIO_SESSION_NOT_LIVE` |
 * | 5 | unbound, or bound to THIS run (idempotent retry) — a consultation counts as elsewhere | 409 `RUN_AUDIO_SESSION_BOUND_ELSEWHERE` |
 * | 6 | the session's ASR agent is the graph's single SPEECH_TO_TEXT node agent (OD-5) | 409 `RUN_AUDIO_AGENT_MISMATCH` |
 *
 * Then `job.metaData.boundRun = { runId, workflowSlug, versionNumber, boundAt }` is written with
 * `updateWithVersion` (OCC): of two concurrent starts on one session, the loser is 409
 * `RUN_AUDIO_SESSION_BOUND_ELSEWHERE` — unless the winner was this same run (a concurrent retry).
 *
 * It MIRRORS the sandbox recording rules (`workflow-sandbox-run.service.ts`
 * `resolveRecordingSession`) without reusing them: ownership here is the CREDENTIAL (OD-2/OD-35),
 * not `createdBy === requestUserId`, so a service account can bind and a second key of the same
 * human cannot (G5). The sandbox keeps its own rule unchanged.
 *
 * A run whose input names no `sttSessionId` anywhere is untouched: {@link bind} returns `null`
 * before any read.
 */

/** The `_metadata` key a streaming job records its opener under (C8). */
export const STREAM_SESSION_OWNER_KEY = 'owner';
/** The `_metadata` key a streaming job records the standalone run it feeds under (C8). */
export const RUN_AUDIO_BOUND_RUN_KEY = 'boundRun';

/** STT job statuses of a session that is still live — the sandbox's `LIVE_RECORDING_STATUSES`. */
export const LIVE_STREAM_JOB_STATUSES: ReadonlySet<string> = new Set(['QUEUED', 'PROCESSING']);

export interface BoundRun {
  runId: string;
  workflowSlug: string | null;
  versionNumber: number | null;
  /** ISO-8601 instant the binding was written; the C5 `timeout` clock starts here. */
  boundAt: string | null;
}

/** The workflow version a run is starting on, as `invoke` resolved it. */
export interface RunAudioWorkflow {
  slug: string;
  versionNumber: number | null;
  /** The PER-RUN compiled config (follow-latest already applied) — its trigger schema is what the run validates. */
  compiledConfig: unknown;
  graph: unknown;
}

export interface BindRunAudioInput {
  tenantId: string;
  runId: string;
  workflow: RunAudioWorkflow;
  input: Record<string, unknown> | undefined;
}

/** A binding `invoke` carries to the harness start (C7) and releases if that start fails. */
export interface RunAudioBinding {
  liveAudio: StartWorkflowRunLiveAudio;
  /** Undo the bind when the run could not be started. A no-op when this call did not write it (a retry). */
  release(): Promise<void>;
}

interface StreamJobLike {
  id: string;
  tenantId?: string;
  version?: number;
  status?: unknown;
  completedAt?: Date | null;
  consultationId?: string | null;
  resolvedSpec?: unknown;
  metaData?: Record<string, unknown> | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every top-level `input` key whose value is an object naming an `sttSessionId`. Pure. */
export function liveAudioRequestsIn(input: unknown): Array<{ key: string; sttSessionId: unknown }> {
  if (!isPlainObject(input)) return [];
  return Object.entries(input)
    .filter(([, value]) => isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'sttSessionId'))
    .map(([key, value]) => ({ key, sttSessionId: (value as Record<string, unknown>).sttSessionId }));
}

/**
 * The trigger's stream-audio Input keys: the open object whose `sttSessionId` names the session
 * (`STREAM_AUDIO_PAYLOAD_SCHEMA`). The same predicate as the sandbox's `isStreamAudioSchema`.
 */
export function streamAudioKeysOf(compiledConfig: unknown): string[] {
  const schema = frozenTriggerPayloadSchema(compiledConfig);
  const properties = schema && isPlainObject(schema.properties) ? schema.properties : {};
  return Object.keys(properties).filter((key) => {
    const kind = properties[key];
    return isPlainObject(kind) && isPlainObject(kind.properties) && isPlainObject(kind.properties.sttSessionId) && !isMediaReferenceSchema(kind);
  });
}

/** The session's opener (C8), or `null` — none recorded (a session opened before C8), or malformed. */
export function readSessionOwner(metaData: unknown): RunPrincipal | null {
  if (!isPlainObject(metaData)) return null;
  return readRunStartedBy({ [RUN_STARTED_BY_KEY]: metaData[STREAM_SESSION_OWNER_KEY] });
}

/** The standalone run a streaming job is bound to, or `null`. */
export function readBoundRun(metaData: unknown): BoundRun | null {
  const value = isPlainObject(metaData) ? metaData[RUN_AUDIO_BOUND_RUN_KEY] : undefined;
  if (!isPlainObject(value) || typeof value.runId !== 'string' || value.runId.length === 0) return null;
  return {
    runId: value.runId,
    workflowSlug: typeof value.workflowSlug === 'string' ? value.workflowSlug : null,
    versionNumber: typeof value.versionNumber === 'number' ? value.versionNumber : null,
    boundAt: typeof value.boundAt === 'string' ? value.boundAt : null,
  };
}

/** `true` while the session's job row is live (QUEUED / PROCESSING, never completed). */
export function isLiveStreamJob(job: { status?: unknown; completedAt?: Date | null }): boolean {
  return LIVE_STREAM_JOB_STATUSES.has(String(job.status)) && !job.completedAt;
}

/** A whole number of seconds in the descriptor's range, else the default (fail open). */
export function liveAudioMaxSecondsOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 60 && value <= 3600 ? value : WORKFLOW_RUNS_DEFAULTS.liveAudioMaxSeconds;
}

/** The session's resolved ASR agent slug, as the job row froze it at session create. */
function sessionAgentSlug(resolvedSpec: unknown): string | null {
  const agent = isPlainObject(resolvedSpec) ? resolvedSpec.agent : undefined;
  return isPlainObject(agent) && typeof agent.slug === 'string' && agent.slug.length > 0 ? agent.slug : null;
}

function coded(status: 400 | 409, code: string, message: string): BadRequestException | ConflictException {
  return status === 400 ? new BadRequestException({ code, message }) : new ConflictException({ code, message });
}

/** The ONE 404 — unknown, foreign, another principal's, and ownerless sessions are indistinguishable. */
function sessionNotFound(sttSessionId: string): NotFoundException {
  return new NotFoundException(`STT session '${sttSessionId}' not found.`);
}

function boundElsewhere(sttSessionId: string): ConflictException {
  return coded(
    409,
    'RUN_AUDIO_SESSION_BOUND_ELSEWHERE',
    `STT session '${sttSessionId}' already feeds a consultation or another run; open a new session for this run.`,
  ) as ConflictException;
}

/**
 * The consultation-bound route (`consultations/:id/workflows/:slug/runs`): a consultation run
 * already gets its audio through the consultation, so naming a session there is refused (400).
 */
export function assertNoLiveAudio(input: Record<string, unknown> | undefined): void {
  if (liveAudioRequestsIn(input).length === 0) return;
  throw coded(
    400,
    'LIVE_AUDIO_UNSUPPORTED',
    'A consultation-bound run takes its audio from the consultation; `sttSessionId` is accepted only by POST /workflows/{slug}/runs.',
  );
}

@Injectable()
export class RunAudioBindingService {
  private readonly logger = new Logger(RunAudioBindingService.name);

  constructor(
    // All optional so a minimal fixture constructs; a run that ASKS for live audio without them is
    // refused (503) rather than started with an unchecked session.
    @Optional() private readonly jobs?: TranscriptionJobRepository,
    @Optional() private readonly runAccess?: RunPrincipalAccessService,
    @Optional() private readonly asrReader?: GoverningWorkflowAsrReader,
    @Optional() private readonly tenantSettings?: TenantSettingsService,
  ) {}

  /** Validate (C3) and bind (C8). `null` when the input names no live session. */
  async bind(params: BindRunAudioInput): Promise<RunAudioBinding | null> {
    const requests = liveAudioRequestsIn(params.input);
    if (requests.length === 0) return null;

    // 1 — shape.
    const declared = new Set(streamAudioKeysOf(params.workflow.compiledConfig));
    const undeclared = requests.filter((request) => !declared.has(request.key)).map((request) => request.key);
    if (undeclared.length > 0) {
      throw coded(
        400,
        'RUN_AUDIO_INPUT_UNDECLARED',
        `'sttSessionId' was supplied on [${undeclared.join(', ')}], which this workflow's input shape does not declare as live audio` +
          (declared.size > 0 ? ` (its live-audio input is [${[...declared].join(', ')}]).` : ' (it declares no live audio).'),
      );
    }
    if (requests.length > 1) {
      throw coded(400, 'RUN_AUDIO_MULTIPLE', `A run binds one live STT session; 'sttSessionId' was supplied on [${requests.map((r) => r.key).join(', ')}].`);
    }
    const [{ sttSessionId: rawSessionId }] = requests;
    if (typeof rawSessionId !== 'string' || rawSessionId.trim().length === 0) {
      throw new BadRequestException(`'sttSessionId' must be a non-empty string.`);
    }
    const sttSessionId = rawSessionId;

    // 2 — settings (OD-10). Legacy (no settings) is refused the same way.
    const exposure = effectiveExposureSettings({ compiledConfig: params.workflow.compiledConfig, graph: params.workflow.graph });
    if (exposure.origin === 'legacy' || !isWorkflowEntryAllowed(exposure, 'socket')) {
      throw coded(
        400,
        'LIVE_AUDIO_UNSUPPORTED',
        `Workflow '${params.workflow.slug}' does not admit live audio: its settings must include the 'socket' connection (it admits [${exposure.connections.join(', ')}]).`,
      );
    }

    if (!this.jobs || !this.runAccess || !this.asrReader) {
      throw new ServiceUnavailableException('Live audio is unavailable: the STT session store is not configured.');
    }

    // 3 — ownership (C8): tenant + STREAMING + the same principal; an ownerless session never binds.
    const job = await this.findStreamJob(params.tenantId, sttSessionId);
    const owner = job ? readSessionOwner(job.metaData) : null;
    if (!job || job.tenantId !== params.tenantId || !sameRunPrincipal(owner, this.runAccess.currentPrincipal())) {
      throw sessionNotFound(sttSessionId);
    }

    // 4 — live.
    if (!isLiveStreamJob(job)) {
      throw coded(409, 'RUN_AUDIO_SESSION_NOT_LIVE', `STT session '${sttSessionId}' has ended; a run binds a live session.`);
    }

    // 5 — unbound, or bound to THIS run (the deterministic id of an idempotent retry).
    const bound = readBoundRun(job.metaData);
    if (job.consultationId || (bound && bound.runId !== params.runId)) throw boundElsewhere(sttSessionId);
    const alreadyBound = bound?.runId === params.runId;

    // 6 — agent agreement (OD-5).
    await this.assertAgentAgreement(params, job, sttSessionId);

    const liveAudio: StartWorkflowRunLiveAudio = { sttSessionId, maxWaitSeconds: this.resolveMaxWaitSeconds(params.tenantId) };
    if (alreadyBound) return { liveAudio, release: async () => {} };

    const wrote = await this.writeBinding(params, job, sttSessionId);
    return { liveAudio, release: wrote ? () => this.release(params.tenantId, params.runId, sttSessionId) : async () => {} };
  }

  /** `workflowRuns.liveAudioMaxSeconds` for the tenant (tenant → SYSTEM), failing open to 3600. */
  resolveMaxWaitSeconds(tenantId: string): number {
    try {
      return liveAudioMaxSecondsOf(this.tenantSettings?.resolve<number>(WORKFLOW_RUNS_LIVE_AUDIO_MAX_SECONDS_KEY, tenantId).value);
    } catch {
      return WORKFLOW_RUNS_DEFAULTS.liveAudioMaxSeconds;
    }
  }

  private async findStreamJob(tenantId: string, sttSessionId: string): Promise<StreamJobLike | null> {
    const [job] = (await this.jobs!.findAll({
      filters: { tenantId, streamSessionId: sttSessionId, jobType: TranscriptionJobType.STREAMING },
    } as never)) as unknown as StreamJobLike[];
    return job ?? null;
  }

  private async assertAgentAgreement(params: BindRunAudioInput, job: StreamJobLike, sttSessionId: string): Promise<void> {
    const mismatch = (detail: string) =>
      coded(409, 'RUN_AUDIO_AGENT_MISMATCH', `STT session '${sttSessionId}' cannot feed workflow '${params.workflow.slug}': ${detail}`);
    let graphAgent: string | null;
    try {
      const named = await this.asrReader!.findAsrAgent(params.tenantId, {
        slug: params.workflow.slug,
        versionNumber: params.workflow.versionNumber,
        compiledConfig: params.workflow.compiledConfig,
      });
      graphAgent = named?.agentSlug ?? null;
    } catch (error) {
      // More than one SPEECH_TO_TEXT node: no single agent the session could agree with.
      if (error instanceof ConflictException) throw mismatch('the workflow names more than one speech-to-text agent.');
      throw error;
    }
    if (graphAgent === null) throw mismatch('the workflow has no speech-to-text step to read it.');
    const sessionAgent = sessionAgentSlug(job.resolvedSpec);
    if (sessionAgent !== graphAgent) {
      throw mismatch(
        `the session transcribes with '${sessionAgent ?? 'an unknown agent'}', the workflow's speech-to-text step with '${graphAgent}'. ` +
          `Open the session with { workflowSlug: '${params.workflow.slug}' }.`,
      );
    }
  }

  /** `true` when THIS call wrote the binding; `false` when a concurrent start of the same run did. */
  private async writeBinding(params: BindRunAudioInput, job: StreamJobLike, sttSessionId: string): Promise<boolean> {
    const boundRun: BoundRun = {
      runId: params.runId,
      workflowSlug: params.workflow.slug,
      versionNumber: params.workflow.versionNumber,
      boundAt: new Date().toISOString(),
    };
    job.metaData = { ...(job.metaData ?? {}), [RUN_AUDIO_BOUND_RUN_KEY]: boundRun };
    try {
      await this.jobs!.updateWithVersion(job.id, job as never, job.version ?? 1);
      return true;
    } catch (error) {
      if (!(error instanceof OptimisticConcurrencyException)) throw error;
      const current = await this.findStreamJob(params.tenantId, sttSessionId);
      if (current && readBoundRun(current.metaData)?.runId === params.runId) return false;
      throw boundElsewhere(sttSessionId);
    }
  }

  /** Best effort: drop `boundRun` while it still names this run. Never throws. */
  private async release(tenantId: string, runId: string, sttSessionId: string): Promise<void> {
    try {
      const job = await this.findStreamJob(tenantId, sttSessionId);
      if (!job || readBoundRun(job.metaData)?.runId !== runId) return;
      const { [RUN_AUDIO_BOUND_RUN_KEY]: _released, ...rest } = job.metaData ?? {};
      job.metaData = rest;
      await this.jobs!.updateWithVersion(job.id, job as never, job.version ?? 1);
    } catch (error) {
      this.logger.warn({
        message: 'run-audio binding could not be released after a failed run start; the session stays bound to a run that never started',
        runId,
        sttSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
