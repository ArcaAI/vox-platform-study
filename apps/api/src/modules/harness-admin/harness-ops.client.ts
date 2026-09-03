import { HttpService } from '@nestjs/axios';
import { HttpException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretsService, resolveInternalAccessToken } from '@arcaai/applications';
import { isAxiosError } from 'axios';

import { describeCauseForOperator } from '../../filters/downstream-error';

/** opaque stand-ins. The cause goes to the log; the client gets these. */
const UPSTREAM_ERROR_MESSAGE = 'The harness service returned an error.';
const TRANSPORT_ERROR_MESSAGE = 'Note generation is temporarily unavailable. Please retry.';

/**
 * Base path of the harness admin surface. The
 * Python agent builds matching endpoints under this prefix on apps/harness; the
 * request/response contracts below are the source of truth for that work.
 */
const HARNESS_ADMIN_BASE = '/api/v1/internal/harness';
const DEFAULT_TIMEOUT_MS = 15_000;

/** A Temporal workflow summary as projected by the harness admin surface. */
export interface HarnessWorkflowSummary {
  workflowId: string;
  runId: string | null;
  consultationId: string | null;
  /** Owning tenant (from the `HarnessTenantId` search attribute / memo). */
  tenantId: string | null;
  /** Temporal status: RUNNING | COMPLETED | FAILED | CANCELED | TERMINATED | TIMED_OUT | CONTINUED_AS_NEW. */
  status: string;
  /** Harness loop phase (e.g. NER | ASSEMBLE | GENERATE | SENSORS | GATE), when reported. */
  phase: string | null;
  startedAt: string | null;
  closeTime: string | null;
  regenCount: number | null;
  escalations: number | null;
  slaSeconds: number | null;
}

/** A page of workflow summaries (Temporal `list_workflows` is cursor-paginated). */
export interface HarnessWorkflowListResult {
  items: HarnessWorkflowSummary[];
  nextPageToken: string | null;
}

/** A single workflow's full description (`?phase=true` adds the loop phase). */
export interface HarnessWorkflowDetail extends HarnessWorkflowSummary {
  historyLength: number | null;
  pendingActivities: unknown[] | null;
  memo: Record<string, unknown> | null;
  searchAttributes: Record<string, unknown> | null;
  result: unknown | null;
}

/** The harness acknowledgement of a cancel / terminate / signal request. */
export interface HarnessWorkflowActionResult {
  workflowId: string;
  runId: string | null;
  status: string;
  action: 'cancel' | 'terminate' | 'signal';
  requested: boolean;
}

export interface ListWorkflowsParams {
  tenantId?: string;
  status?: string;
  consultationId?: string;
  limit?: number;
  pageToken?: string;
}

/**
 * HarnessOpsClient.
 *
 * The OUTBOUND half of the apps/api → apps/harness workflow-ops adapter. Speaks
 * HTTP only (the Temporal SDK stays isolated in apps/harness), authenticating
 * with `X-Service-Token: <HARNESS_SERVICE_TOKEN>` exactly like
 * `HarnessGatewayService`. Base URL resolves from `HARNESS_BASE_URL`, then the
 * legacy `HARNESS_URL`, then `http://localhost:8866`.
 *
 * Contract assumed of the harness admin surface (paths under
 * `/api/v1/internal/harness`):
 *  - `GET /workflows?tenantId&status&consultationId&limit&pageToken` → HarnessWorkflowListResult
 *  - `GET /workflows/{id}?phase=true&tenantId` → HarnessWorkflowDetail
 *  - `POST /workflows/{id}/cancel` body `{ tenantId?, reason? }` → HarnessWorkflowActionResult
 *  - `POST /workflows/{id}/terminate` body `{ tenantId?, reason? }` → HarnessWorkflowActionResult
 *  - `POST /workflows/{id}/signal` body `{ tenantId?, signalName, payload? }` → HarnessWorkflowActionResult
 *
 * Tenant ownership is enforced by the caller (controller): tenant admins are
 * limited to their own tenant; platform admins (GLOBAL ability) act cross-tenant.
 */
@Injectable()
export class HarnessOpsClient {
  private readonly logger = new Logger(HarnessOpsClient.name);
  private readonly baseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    // Optional so unit fixtures compile without a mock; an unset token yields an
    // empty `X-Service-Token`, which the harness-side guard rejects (fail-closed).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    this.baseUrl = this.configService.get<string>('HARNESS_BASE_URL') ?? this.configService.get<string>('HARNESS_URL') ?? 'http://localhost:8866';
  }

  async listWorkflows(params: ListWorkflowsParams = {}): Promise<HarnessWorkflowListResult> {
    const data = await this.get<Partial<HarnessWorkflowListResult>>(`${HARNESS_ADMIN_BASE}/workflows`, {
      tenantId: params.tenantId,
      status: params.status,
      consultationId: params.consultationId,
      limit: params.limit,
      pageToken: params.pageToken,
    });
    return { items: data.items ?? [], nextPageToken: data.nextPageToken ?? null };
  }

  async describeWorkflow(workflowId: string, params: { phase?: boolean; tenantId?: string } = {}): Promise<HarnessWorkflowDetail> {
    return this.get<HarnessWorkflowDetail>(`${HARNESS_ADMIN_BASE}/workflows/${encodeURIComponent(workflowId)}`, {
      phase: params.phase ? 'true' : undefined,
      tenantId: params.tenantId,
    });
  }

  async cancelWorkflow(workflowId: string, body: { tenantId?: string; reason?: string } = {}): Promise<HarnessWorkflowActionResult> {
    return this.post<HarnessWorkflowActionResult>(`${HARNESS_ADMIN_BASE}/workflows/${encodeURIComponent(workflowId)}/cancel`, body);
  }

  async terminateWorkflow(workflowId: string, body: { tenantId?: string; reason?: string } = {}): Promise<HarnessWorkflowActionResult> {
    return this.post<HarnessWorkflowActionResult>(`${HARNESS_ADMIN_BASE}/workflows/${encodeURIComponent(workflowId)}/terminate`, body);
  }

  async signalWorkflow(workflowId: string, body: { tenantId?: string; signalName: string; payload?: unknown }): Promise<HarnessWorkflowActionResult> {
    return this.post<HarnessWorkflowActionResult>(`${HARNESS_ADMIN_BASE}/workflows/${encodeURIComponent(workflowId)}/signal`, body);
  }

  private async get<T>(path: string, params: Record<string, unknown>): Promise<T> {
    try {
      const response = await this.httpService.axiosRef.get<T>(`${this.baseUrl}${path}`, {
        headers: await this.buildHeaders(),
        params,
        timeout: DEFAULT_TIMEOUT_MS,
      });
      return response.data;
    } catch (error) {
      throw this.toHttpError(error, `GET ${path}`);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    try {
      const response = await this.httpService.axiosRef.post<T>(`${this.baseUrl}${path}`, body, {
        headers: await this.buildHeaders(),
        timeout: DEFAULT_TIMEOUT_MS,
      });
      return response.data;
    } catch (error) {
      throw this.toHttpError(error, `POST ${path}`);
    }
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    // Shared `INTERNAL_ACCESS_TOKEN` first, legacy `HARNESS_SERVICE_TOKEN` as the
    // compatibility fallback — the same resolution every other internal client
    // uses. Reading the legacy key directly made this the one hop that could not
    // move to the shared credential.
    const token = await resolveInternalAccessToken(this.secretsService, 'HARNESS_SERVICE_TOKEN');
    return {
      'Content-Type': 'application/json',
      'X-Service-Token': token,
    };
  }

  /**
   * Translate an upstream failure into a Nest HttpException: surface the
   * harness's own status + body when it responded, else a 503 for transport
   * errors (DNS/connect/timeout). Never leak the service token.
   */
  private toHttpError(error: unknown, action: string): HttpException {
    if (isAxiosError(error) && error.response) {
      this.logger.warn({ message: 'Harness ops upstream error', action, status: error.response.status });
      // the `?? { message: error.message }` fallback meant an EMPTY
      // upstream body fell back to the axios message — `connect ECONNREFUSED
      // 127.0.0.1:8866`. An absent body now yields an opaque one; the upstream's
      // own body is still forwarded (this is a super-admin ops surface whose
      // contract is to surface the harness's own error), and its status is kept.
      const body = error.response.data ?? { message: UPSTREAM_ERROR_MESSAGE };
      return new HttpException(body as string | Record<string, unknown>, error.response.status);
    }
    this.logger.error({ message: 'Harness ops transport error', action, ...describeCauseForOperator(error) });
    // was `\`Harness ops request failed (${action}): ${message}\,
    // which leaked the harness host:port. Cause to the log, capability to the client.
    return new ServiceUnavailableException(TRANSPORT_ERROR_MESSAGE);
  }
}
