/**
 * P0.5 — v2 native, consultation-bound summarization (persisted). Backed by
 * `apps/api/src/modules/consultation/consultation.controller.ts`'s `:id/summary*`
 * routes, behind the gateway's `api/v1` prefix like every other route. A note is
 * GENERATED only on the async plane (`generateAsync` / `generatePreSummaryAsync`,
 * then `hope.jobs.waitFor`); the synchronous generate routes were removed by
 * TASK-1006, and the v1-compat summarization resource by TASK-1004.
 */

import { encodePathSegment } from '../core/url';
import { toStrongValidator } from '../core/if-match';
import type { Transport } from '../core/transport';
import { generateUuidV7 } from '../core/idempotency';
import type {
  ApproveSummaryRequest,
  AsyncJobResponse,
  ConsultationSummaryResponse,
  GeneratePreSummaryRequest,
  GenerateSummaryRequest,
  SummaryApprovalResponse,
  UpdateSummaryRequest,
} from '../types/consultation';

/** Per-call options shared by every read/list method on {@link ConsultationSummariesResource}. */
export interface ConsultationSummaryRequestOptions {
  signal?: AbortSignal;
  /** Per-call request timeout. Overrides the transport default. */
  timeoutMs?: number;
}

/** Options for {@link ConsultationSummariesResource.update}. */
export interface UpdateSummaryOptions extends ConsultationSummaryRequestOptions {
  /**
   * Sent as the `If-Match` header. **REQUIRED by the gateway**: the route carries
   * `@RequiresIfMatch()`, so an omitted header is a guaranteed 428 and a stale one a 412
   * (`VersionConflictError`). Pass the summary's `version` as read (`'"7"'`). Typed optional only
   * so existing callers keep compiling.
   */
  ifMatch?: string;
}

/** Options for {@link ConsultationSummariesResource.approve}. */
export interface ApproveSummaryOptions extends ConsultationSummaryRequestOptions {
  /**
   * Sent as `If-Match`. **REQUIRED** — like `update()`'s route, this one
   * carries `@RequiresIfMatch()` on the gateway, so an omitted header is a
   * guaranteed 428, not a silently-skipped precondition. Pass the strong
   * validator you read the summary at (e.g. `'"7"'`).
   */
  ifMatch: string | number;
}

function consultationSummaryPath(consultationId: string): string {
  return `consultations/${encodePathSegment(consultationId)}/summary`;
}

export class ConsultationSummariesResource {
  constructor(private readonly transport: Transport) {}

  /**
   * `POST /api/v1/consultations/:id/summary/async` → `{ jobId, status, ... }`.
   * Pair with `hope.jobs.waitFor(jobId)`. `idempotencyKey` is a BODY field
   * (`GenerateSummaryRequest.idempotencyKey`), auto-generated via
   * `core/idempotency.ts#generateUuidV7` when the caller omits one — this
   * makes the POST safe to retry (`hasIdempotencyKey: true`), and lets the
   * gateway's Redis dedupe-by-`(tenantId, userId, key)` return the prior
   * `jobId` on a genuine double-submit.
   */
  async generateAsync(
    consultationId: string,
    request: GenerateSummaryRequest = {},
    options: ConsultationSummaryRequestOptions = {},
  ): Promise<AsyncJobResponse> {
    const body: GenerateSummaryRequest = { ...request, idempotencyKey: request.idempotencyKey ?? generateUuidV7() };
    return this.transport.request<AsyncJobResponse>({
      method: 'POST',
      path: `${consultationSummaryPath(consultationId)}/async`,
      body,
      hasIdempotencyKey: true,
      signal: options.signal,
    });
  }

  /** `POST /api/v1/consultations/:id/summary/pre-summary/async` → `{ jobId, status, ... }`. Same auto-generated-idempotency-key behavior as {@link generateAsync}. */
  async generatePreSummaryAsync(
    consultationId: string,
    request: GeneratePreSummaryRequest = {},
    options: ConsultationSummaryRequestOptions = {},
  ): Promise<AsyncJobResponse> {
    const body: GeneratePreSummaryRequest = { ...request, idempotencyKey: request.idempotencyKey ?? generateUuidV7() };
    return this.transport.request<AsyncJobResponse>({
      method: 'POST',
      path: `${consultationSummaryPath(consultationId)}/pre-summary/async`,
      body,
      hasIdempotencyKey: true,
      signal: options.signal,
    });
  }

  /** `GET /api/v1/consultations/:id/summary` — every summary/pre-summary generated for the consultation. */
  async list(consultationId: string, options: ConsultationSummaryRequestOptions = {}): Promise<ConsultationSummaryResponse[]> {
    return this.transport.request<ConsultationSummaryResponse[]>({
      path: consultationSummaryPath(consultationId),
      signal: options.signal,
    });
  }

  /** `GET /api/v1/consultations/:id/summary/latest`. */
  async latest(consultationId: string, options: ConsultationSummaryRequestOptions = {}): Promise<ConsultationSummaryResponse | null> {
    return this.transport.request<ConsultationSummaryResponse | null>({
      path: `${consultationSummaryPath(consultationId)}/latest`,
      signal: options.signal,
    });
  }

  /** `GET /api/v1/consultations/:id/summary/pre-summary/latest`. */
  async latestPreSummary(consultationId: string, options: ConsultationSummaryRequestOptions = {}): Promise<ConsultationSummaryResponse | null> {
    return this.transport.request<ConsultationSummaryResponse | null>({
      path: `${consultationSummaryPath(consultationId)}/pre-summary/latest`,
      signal: options.signal,
    });
  }

  /** `PATCH /api/v1/consultations/:id/summary/:summaryId` — under `If-Match` (see {@link UpdateSummaryOptions.ifMatch}). */
  async update(
    consultationId: string,
    summaryId: string,
    request: UpdateSummaryRequest,
    options: UpdateSummaryOptions = {},
  ): Promise<ConsultationSummaryResponse> {
    const headers: Record<string, string> = {};
    if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
    return this.transport.request<ConsultationSummaryResponse>({
      method: 'PATCH',
      path: `${consultationSummaryPath(consultationId)}/${encodePathSegment(summaryId)}`,
      body: request,
      headers,
      signal: options.signal,
    });
  }

  /**
   * `POST /api/v1/consultations/:id/summary/:contextItemId/approve` — sign
   * and lock the summary under optimistic concurrency (TASK-972).
   *
   * `contextItemId` is the summary's context-item id (the same id
   * {@link ConsultationSummariesResource.generate}/`list`/`latest` return as
   * `id`), **not** the consultation id.
   *
   * Accepted while the consultation is `PENDING_REVIEW`, `DRAFT_PENDING_SENSORS`, `TIMED_OUT` or
   * `CLOSED_INCOMPLETE` — a consultation the completion timeout closed unsigned still signs
   * (TASK-1001); any other state is a 409. The gateway compare-and-sets against the summary row's
   * `_version` — see {@link ApproveSummaryOptions.ifMatch}.
   */
  async approve(
    consultationId: string,
    contextItemId: string,
    request: ApproveSummaryRequest = {},
    options: ApproveSummaryOptions,
  ): Promise<SummaryApprovalResponse> {
    return this.transport.request<SummaryApprovalResponse>({
      method: 'POST',
      path: `${consultationSummaryPath(consultationId)}/${encodePathSegment(contextItemId)}/approve`,
      body: request,
      headers: { 'If-Match': toStrongValidator(options.ifMatch) },
      signal: options.signal,
    });
  }
}
