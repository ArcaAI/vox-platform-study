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
   * TASK-551 — DNA redaction/rewrite rules resolved + decrypted by the caller
   * (tenant + doctor double-gate via `ConfigResolver.resolveEffectiveDnaRedactionEnabled`
   * + the doctor's decrypted DNA `redactionRules`). Omitted/empty ⇒ the workflow's
   * apply_redaction insertion is a no-op. Each entry is the RedactionRule shape
   * ({ id, type, match, pattern, replacement?, note? }).
   */
  redactionRules?: Record<string, unknown>[];
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
      // TASK-551 — omit entirely when empty so the request stays byte-identical
      // to the pre-redaction body (the harness defaults redactionRules to []).
      ...(ctx.redactionRules && ctx.redactionRules.length > 0 ? { redactionRules: ctx.redactionRules } : {}),
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

  private async buildHeaders(): Promise<Record<string, string>> {
    const token = (await this.secretsService?.getSecretOptional('HARNESS_SERVICE_TOKEN')) ?? '';
    return {
      'Content-Type': 'application/json',
      'X-Service-Token': token,
    };
  }
}
