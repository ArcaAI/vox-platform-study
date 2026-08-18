import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { SecretsService } from '../../baseServices/_meta/secrets';

/**
 * Context for starting a durable harness document workflow. `tenantId` is
 * REQUIRED and travels in the request body (the harness re-establishes CLS
 * from it on its side). `jobId` lets the existing SSE pub/sub channel
 * (`consultation_job_updates:{jobId}`) surface progress to the frontend.
 */
export interface HarnessStartContext {
  tenantId: string;
  userId?: string;
  jobId?: string;
  correlationId?: string;
  /** The transcript ContextItem that triggered generation. */
  contextItemId?: string;
  /**
   * The transcript text the workflow runs NER + sensors against. apps/api stays
   * the sole DB reader, so it supplies the text at start; the assemble callback
   * re-loads the transcript on the apps/api side as the prompt's source of truth.
   */
  transcriptText?: string;
  /**
   * DNA redaction/rewrite rules resolved + decrypted by the caller
   * (tenant + doctor double-gate via `ConfigResolver.resolveEffectiveDnaRedactionEnabled`
   * + the doctor's decrypted DNA `redactionRules`). Omitted/empty ⇒ the workflow's
   * apply_redaction insertion is a no-op. Each entry is the RedactionRule shape
   * ({ id, type, match, pattern, replacement?, note? }).
   */
  redactionRules?: Record<string, unknown>[];
  /**
   * `Consultation.patientId` (TASK-712, consent-abac Phase 4) — threaded onto
   * `HarnessDocWorkflowInput` so the `call_mcp_tool`/`retrieve_context`
   * activities can key a consent-gate lookup. Omitted ⇒ those activities
   * degrade to `consent_unavailable` (fail-closed, but distinguishable from
   * a genuine denial — R4) rather than crash.
   */
  externalPatientId?: string;
}

/**
 * Sign-off signal payload forwarded to the harness so it can resolve the
 * workflow's `approval` wait-condition. The WORM write in apps/api is the
 * source of truth; this is a best-effort notification.
 */
export interface HarnessApprovalSignal {
  tenantId?: string;
  contextItemVersionId?: string;
  attestationHash?: string;
  clinicianId?: string;
  decision?: string;
}

/**
 * Edit signal payload forwarded to the harness when
 * a clinician edits an optimistically-delivered draft that is still
 * `DRAFT_PENDING_SENSORS`. The workflow re-binds + re-runs assurance on the
 * edited content and disables the silent regen-if-untouched path. Like
 * `signalApproval` this is a best-effort notification — the apps/api version
 * write is the source of truth.
 */
export interface HarnessEditSignal {
  /** The edited note the assurance pass must re-screen (required). */
  content: string;
  /** The apps/api MODIFIED_SUMMARY version the verdict must bind to. */
  contextItemVersionId?: string;
  editedBy?: string;
}

/**
 * Context-added signal payload forwarded to the harness when a
 * `ConsultationPipelineEvent.ContextAdded` event reaches the loop event
 * plane. Like `signalApproval`/`signalEdit` this is a best-effort
 * notification — `LoopContextSignalService` (the caller) already treats a
 * failed POST as fire-and-forget. The receiving `ConsultationLoopWorkflow`
 * signal handler is built in a later ticket; until it exists the harness
 * endpoint may 404, which the caller tolerates.
 */
export interface HarnessContextAddedSignal {
  tenantId?: string;
  /** The context item that was added. */
  contextItemId: string;
  /** The `ContextItem.type` (e.g. WORKNOTE, TRANSCRIPT, STRUCTURED). */
  contextType: string;
  /** Optional `metadata.subType` label (e.g. 'LAB_RESULT'). */
  subType?: string;
  /** First ~2k chars of text content, when present. */
  contentPreview?: string;
  /**
   * The tenant-declared kind (`ContextItem.kindKey`). The
   * receiver falls back to `subType` then `contextType` when absent, so this
   * is additive-optional on the wire, matching `LoopContextAddedRequest`.
   */
  kindKey?: string;
  /**
   * The gateway's emission timestamp (ISO-8601). Part of the
   * receiver's de-duplication identity alongside `contextItemId` — a re-emit
   * of the SAME item with fresh content (e.g. OCR enrichment) carries a NEW
   * `occurredAt` and is correctly a new event.
   */
  occurredAt?: string;
  /**
   * Cascade generation: 0 for a human/API-originated item,
   * parent depth + 1 for anything written via `derivedFromContextItemId`.
   * Absent ⇒ the receiver defaults to 0.
   */
  depth?: number;
  /**
   * The fuller context body (up to `LOOP_SIGNAL_CONTENT_MAX_LENGTH`
   * chars — see `context.service.ts` for the size-threshold reasoning), so a
   * specialist (`vision.extract_text`, `nlp.extract_entities`) has real text
   * to act on rather than the 2k-char `contentPreview`. Additive-optional: an
   * un-upgraded receiver ignores it and falls back to `contentPreview`.
   */
  content?: string;
}

/**
 * Signal payload forwarded to the harness when a consultation's
 * recording stops, so the running `ConsultationLoopWorkflow` drains, runs its
 * ending actions, and finalizes (starts `HarnessDocWorkflow` as its child).
 * Best-effort like `signalContextAdded`/`signalEdit`: the caller treats a
 * failed POST as fire-and-forget — the recording-stop path must never fail
 * because the loop is unreachable or not configured.
 */
export interface HarnessConsultationEndingSignal {
  reason?: string;
  persistSnapshot?: boolean;
  transcriptText?: string;
  contextItemId?: string;
  jobId?: string;
  conversationLanguage?: string;
  dnaStyleId?: string;
  template?: string;
  textProvider?: string;
  textModel?: string;
}

/**
 * Signal payload forwarded to the harness to stop the loop
 * WITHOUT running its ending actions (the consultation was abandoned, not
 * finished). Best-effort, same posture as the other signals.
 */
export interface HarnessLoopCancelSignal {
  reason?: string;
}

/** One golden case sent to the harness eval endpoint (snake_case — the harness
 * `GoldenCase` pydantic model has `extra="forbid"`, so keys must match exactly). */
export interface HarnessEvalCaseInput {
  case_id: string;
  source_documents: string[];
  generated_note: string;
  reference_note?: string | null;
}

/** Body for `POST /api/v1/internal/eval/run`. */
export interface HarnessEvalRunInput {
  goldenSet: {
    version: string;
    name?: string;
    description?: string;
    cases: HarnessEvalCaseInput[];
  };
  promptTemplateId?: string | null;
  promptVersion?: string | null;
  promptVersionNumber?: number | null;
  /** PDSQI-only by default (faithfulness needs a claim extractor/verifier). */
  noFaithfulness?: boolean;
}

/** One flattened (case, metric) score row returned by the harness endpoint. */
export interface HarnessEvalCaseScore {
  caseId: string;
  metric: string;
  score: number;
  maxScore?: number | null;
  judgeModel?: string | null;
}

/** Response of `POST /api/v1/internal/eval/run` — the gate verdict + scores. */
export interface HarnessEvalRunResult {
  golden_set_version: string;
  judge_model: string;
  aggregates: Record<string, number>;
  thresholds: Record<string, number>;
  passed: boolean;
  failures: string[];
  caseScores: HarnessEvalCaseScore[];
  promptTemplateId?: string | null;
  promptVersion?: string | null;
  promptVersionNumber?: number | null;
}

/**
 * Explicit connect+response timeout for the workflow-run dispatcher calls
 * (TASK-722). Axios has NO default timeout — an unreachable/filtered harness
 * host (rather than one that actively refuses the connection) would otherwise
 * hang the calling request indefinitely, discovered via this ticket's own e2e
 * run against an environment with no harness process. `start()` and the
 * `signal*` methods above predate this and are unchanged (out of scope here).
 */
const WORKFLOW_RUN_HTTP_TIMEOUT_MS = 15_000;

/**
 * Out-of-band reference to a claim-checked blob (TASK-718's `ClaimCheckRef`,
 * `apps/harness/src/harness/temporal/claim_check.py:64-80`). The wire body sent to
 * `/workflow-runs:start` MUST spell the content-type field `content_type`
 * (snake_case) — the Python `ClaimCheckRef` model carries no alias of its own
 * (only the OUTER `StartWorkflowRunRequest` fields are camelCase-aliased), and
 * `ConfigDict(extra="forbid")` 422s on an unrecognized `contentType` key.
 */
export interface HarnessClaimCheckRef {
  store: string;
  bucket: string;
  key: string;
  size: number;
  sha256: string;
  content_type: string;
}

/** Body for `POST /workflow-runs:start` (TASK-718 Task 10 / TASK-722 Task 5). */
export interface StartWorkflowRunInput {
  runId: string;
  sessionId: string;
  workflowVersionId: string;
  tenantId: string;
  configRef: HarnessClaimCheckRef;
  sandbox?: boolean;
  /** Forwarded verbatim into `InterpreterInput.payload` (TASK-721 Workbench sandbox test input). */
  payload?: Record<string, unknown>;
}

/** Response of `POST /workflow-runs:start`. */
export interface StartWorkflowRunResult {
  runId: string;
  workflowId: string;
  temporalRunId: string;
  status: 'started' | 'already_running';
}

/** One `WorkflowInterpreter.state` stage, as reported by `GET /workflow-runs/{runId}`. */
export interface HarnessWorkflowRunStage {
  [key: string]: unknown;
}

/** Response of `GET /workflow-runs/{runId}`. */
export interface GetWorkflowRunResult {
  runId: string;
  status: string;
  stages: HarnessWorkflowRunStage[];
  startedAt: string | null;
  endedAt: string | null;
}

/** Response of `POST /workflow-runs/{runId}:cancel`. */
export interface CancelWorkflowRunResult {
  runId: string;
  status: string;
}

/**
 * HarnessGatewayService.
 *
 * The OUTBOUND half of the apps/api <-> apps/harness gate adapter. Uses Nest
 * `HttpService` to POST to the harness internal endpoints, authenticating with
 * `X-Service-Token: <HARNESS_SERVICE_TOKEN>` and carrying `tenantId` in the body.
 *
 * Base URL resolves from `HARNESS_URL` (default `http://localhost:8866`). The
 * Temporal SDK stays isolated inside apps/harness — this service only speaks
 * HTTP, so the durable-workflow concern never leaks into the NestJS gateway.
 */
@Injectable()
export class HarnessGatewayService {
  private readonly logger = new Logger(HarnessGatewayService.name);
  private readonly harnessUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    // Optional so unit fixtures (and any caller that constructs this directly)
    // compile without a mock. When unset we send an empty token, which the
    // harness-side service-token guard rejects (fail-closed on the harness).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    this.harnessUrl = this.configService.get<string>('HARNESS_URL') ?? 'http://localhost:8866';
  }

  /**
   * Start (or no-op re-trigger) the harness document workflow for a consultation.
   */
  async start(consultationId: string, ctx: HarnessStartContext): Promise<unknown> {
    const url = `${this.harnessUrl}/api/v1/internal/consultations/${consultationId}/document:start`;
    const body = {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      jobId: ctx.jobId,
      correlationId: ctx.correlationId,
      contextItemId: ctx.contextItemId,
      transcriptText: ctx.transcriptText,
      // Omit entirely when empty so the request stays byte-identical
      // to the pre-redaction body (the harness defaults redactionRules to []).
      ...(ctx.redactionRules && ctx.redactionRules.length > 0 ? { redactionRules: ctx.redactionRules } : {}),
      ...(ctx.externalPatientId ? { externalPatientId: ctx.externalPatientId } : {}),
    };

    const response = await this.httpService.axiosRef.post(url, body, {
      headers: await this.buildHeaders(),
    });

    this.logger.log({ message: 'Harness document workflow started', consultationId, jobId: ctx.jobId });
    return response.data;
  }

  /**
   * Forward a clinician sign-off to the harness so it can resolve the workflow's
   * approval wait-condition and record the GATE_DECISION audit event.
   */
  async signalApproval(consultationId: string, payload: HarnessApprovalSignal): Promise<unknown> {
    const url = `${this.harnessUrl}/api/v1/internal/workflows/${consultationId}/signal/approve`;

    const response = await this.httpService.axiosRef.post(
      url,
      { ...payload },
      {
        headers: await this.buildHeaders(),
      },
    );

    this.logger.log({ message: 'Harness approval signal sent', consultationId });
    return response.data;
  }

  /**
   * Forward a clinician edit of an optimistically-delivered draft to the harness
   * so the running workflow re-binds + re-runs assurance on the edited content
   * (Q3) and disables the silent regen-if-untouched path (Q1). Best-effort: the
   * apps/api MODIFIED_SUMMARY version write is the source of truth.
   */
  async signalEdit(consultationId: string, payload: HarnessEditSignal): Promise<unknown> {
    const url = `${this.harnessUrl}/api/v1/internal/workflows/${consultationId}/signal/edit`;

    const response = await this.httpService.axiosRef.post(
      url,
      { ...payload },
      {
        headers: await this.buildHeaders(),
      },
    );

    this.logger.log({ message: 'Harness edit signal sent', consultationId });
    return response.data;
  }

  /**
   * Forward a ContextAdded event to the consultation loop workflow so it can
   * resolve its `contextAdded` signal wait-condition and re-evaluate agent
   * subscriptions. Best-effort like `signalEdit` — the apps/api ContextItem
   * write is already durable; this is a live-loop notification only.
   */
  async signalContextAdded(consultationId: string, payload: HarnessContextAddedSignal): Promise<unknown> {
    const url = `${this.harnessUrl}/api/v1/internal/workflows/${consultationId}/signal/context-added`;

    const response = await this.httpService.axiosRef.post(
      url,
      { ...payload },
      {
        headers: await this.buildHeaders(),
      },
    );

    this.logger.log({ message: 'Harness context-added signal sent', consultationId });
    return response.data;
  }

  /**
   * Tell the consultation loop the recording stopped: drain, run ending
   * actions, finalize. Best-effort — a failed POST is fire-and-forget, same
   * as `signalContextAdded`.
   */
  async signalConsultationEnding(consultationId: string, payload: HarnessConsultationEndingSignal): Promise<unknown> {
    const url = `${this.harnessUrl}/api/v1/internal/workflows/${consultationId}/signal/consultation-ending`;

    const response = await this.httpService.axiosRef.post(
      url,
      { ...payload },
      {
        headers: await this.buildHeaders(),
      },
    );

    this.logger.log({ message: 'Harness consultation-ending signal sent', consultationId });
    return response.data;
  }

  /**
   * Tell the consultation loop to stop WITHOUT running its ending actions
   * (the consultation was abandoned). Best-effort, same posture.
   */
  async signalLoopCancel(consultationId: string, payload: HarnessLoopCancelSignal): Promise<unknown> {
    const url = `${this.harnessUrl}/api/v1/internal/workflows/${consultationId}/signal/loop-cancel`;

    const response = await this.httpService.axiosRef.post(
      url,
      { ...payload },
      {
        headers: await this.buildHeaders(),
      },
    );

    this.logger.log({ message: 'Harness loop-cancel signal sent', consultationId });
    return response.data;
  }

  /**
   * Run a synchronous eval over an inlined golden set and return the gate
   * verdict + scores. Wraps `POST /api/v1/internal/eval/run` with the same
   * `X-Service-Token` plumbing as the workflow endpoints. The harness enforces a
   * case-count cap (413) and returns 200 with `passed=false` for a failing gate.
   */
  async runEval(input: HarnessEvalRunInput): Promise<HarnessEvalRunResult> {
    const url = `${this.harnessUrl}/api/v1/internal/eval/run`;
    const response = await this.httpService.axiosRef.post(url, input, {
      headers: await this.buildHeaders(),
    });
    this.logger.log({
      message: 'Harness eval run complete',
      goldenSetVersion: (response.data as HarnessEvalRunResult)?.golden_set_version,
      passed: (response.data as HarnessEvalRunResult)?.passed,
    });
    return response.data as HarnessEvalRunResult;
  }

  /**
   * Start (or idempotently re-attach to, on a workflow-id collision) an
   * interpreter run (TASK-722's exposure plane / TASK-721's Workbench — the
   * two callers TASK-718's own docstring names). `configRef` MUST already be
   * minted (this endpoint never accepts a raw `compiledConfig` — see
   * `interpreter.py:StartWorkflowRunRequest`'s docstring); minting it is the
   * caller's job (`WorkflowExposureService`).
   */
  async startWorkflowRun(input: StartWorkflowRunInput): Promise<StartWorkflowRunResult> {
    const url = `${this.harnessUrl}/api/v1/workflow-runs:start`;
    const body = {
      runId: input.runId,
      sessionId: input.sessionId,
      workflowVersionId: input.workflowVersionId,
      tenantId: input.tenantId,
      configRef: input.configRef,
      sandbox: input.sandbox ?? false,
      payload: input.payload ?? {},
    };
    const response = await this.httpService.axiosRef.post(url, body, { headers: await this.buildHeaders(), timeout: WORKFLOW_RUN_HTTP_TIMEOUT_MS });
    this.logger.log({ message: 'Harness workflow run started', runId: input.runId, status: (response.data as StartWorkflowRunResult)?.status });
    return response.data as StartWorkflowRunResult;
  }

  /** Status/result read surface: `Temporal.describe()` + the workflow's `state` query. */
  async getWorkflowRun(runId: string): Promise<GetWorkflowRunResult> {
    const url = `${this.harnessUrl}/api/v1/workflow-runs/${runId}`;
    const response = await this.httpService.axiosRef.get(url, { headers: await this.buildHeaders(), timeout: WORKFLOW_RUN_HTTP_TIMEOUT_MS });
    return response.data as GetWorkflowRunResult;
  }

  /**
   * Send the interpreter's `cancel` signal — a CODE allow-list (this method's
   * whole surface), never a caller-supplied signal name (the F-09 anti-pattern
   * TASK-722's README names, `harness-admin.controller.ts:485`).
   */
  async cancelWorkflowRun(runId: string): Promise<CancelWorkflowRunResult> {
    const url = `${this.harnessUrl}/api/v1/workflow-runs/${runId}:cancel`;
    const response = await this.httpService.axiosRef.post(url, {}, { headers: await this.buildHeaders(), timeout: WORKFLOW_RUN_HTTP_TIMEOUT_MS });
    this.logger.log({ message: 'Harness workflow run cancel requested', runId });
    return response.data as CancelWorkflowRunResult;
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const token = (await this.secretsService?.getSecretOptional('HARNESS_SERVICE_TOKEN')) ?? '';
    return {
      'Content-Type': 'application/json',
      'X-Service-Token': token,
    };
  }
}
