/**
 * P0.5 — v2 native, consultation-bound summarization (persisted). Backed by
 * `apps/api/src/modules/consultation/consultation.controller.ts`'s `:id/summary*`
 * routes, all of which sit behind the gateway's `api/v1` prefix (not exempt —
 * only the v1-compat summarization shims in `./summarization.ts` are).
 */

import { encodePathSegment } from '../core/url';
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
  /**
   * Per-call request timeout. On the SYNCHRONOUS generation routes (`generate`, `generatePreSummary`)
   * the precedence is: this value → the client's explicit `timeoutMs` → {@link SYNC_GENERATION_TIMEOUT_MS}.
   * Every other method keeps the transport default.
   */
  timeoutMs?: number;
}

/**
 * The floor for a synchronous generation call when neither the call nor the client names a timeout.
 *
 * TASK-946 §5.1: a four-note Breast & Endocrine pre-summary took 46–68 s on `gemma-4-e2b` while the
 * transport's 60 s default (sized for reads and writes) gave up first — the gateway answered 200 to a
 * caller that had already gone. A generation is long by nature, so it carries its own floor. Prefer
 * `generateAsync`/`generatePreSummaryAsync` plus the `presummary` SSE plane when you can wait elsewhere.
 */
export const SYNC_GENERATION_TIMEOUT_MS = 180_000;

/** Options for {@link ConsultationSummariesResource.generate}. */
export interface GenerateSummaryOptions extends ConsultationSummaryRequestOptions {
  /**
   * Overrides `request.idempotencyKey` when set. NOT auto-generated on this
   * route: `SummaryService.generateSummary` (the synchronous handler behind
   * `POST :id/summary`) never reads `idempotencyKey` — there is no background
   * job to dedupe against, unlike the `*Async` routes below. Supplying one is
   * harmless (it round-trips as an unused body field) but has no effect.
   */
  idempotencyKey?: string;
}

/** Options for {@link ConsultationSummariesResource.update}. */
export interface UpdateSummaryOptions extends ConsultationSummaryRequestOptions {
  /**
   * Sent as the `If-Match` header when set.
   *
   * NOTE — unlike the general HOPE house pattern for versioned PATCH routes
   * (`.claude/rules/05-nestjs-api.md` "Optimistic Concurrency"), the gateway's
   * `PATCH :id/summary/:summaryId` route carries neither `@RequiresIfMatch()`
   * nor `@ExpectedVersion()` (verified against
   * `apps/api/src/modules/consultation/consultation.controller.ts` — the
   * `updateSummary` handler has no OCC decorators at all), and
   * `SummaryService.updateSummary` has no `_version`/`updateWithVersion` path
   * — every edit is instead appended as a new `ContextItemVersion` row. So
   * TODAY, on this specific route: `If-Match` is accepted and forwarded but
   * has NO server-side effect, a missing `If-Match` never yields 428, and a
   * conflicting edit never yields 412. This option (and the SDK's generic
   * `VersionConflictError`/`PreconditionRequiredError` mapping in
   * `core/errors.ts`) is kept for forward compatibility in case OCC is added
   * to this route later, and so the SDK's behavior is uniform with every
   * other versioned resource in the meantime.
   */
  ifMatch?: string;
}

/** Options for {@link ConsultationSummariesResource.approve}. */
export interface ApproveSummaryOptions extends ConsultationSummaryRequestOptions {
  /**
   * Sent as `If-Match`. **REQUIRED** — unlike `update()`'s route, this one
   * carries `@RequiresIfMatch()` on the gateway, so an omitted header is a
   * guaranteed 428, not a silently-skipped precondition. Pass the strong
   * validator you read the summary at (e.g. `'"7"'`).
   */
  ifMatch: string;
}

function consultationSummaryPath(consultationId: string): string {
  return `consultations/${encodePathSegment(consultationId)}/summary`;
}

export class ConsultationSummariesResource {
  constructor(private readonly transport: Transport) {}

  /** Call → the client's explicit `timeoutMs` → {@link SYNC_GENERATION_TIMEOUT_MS}. */
  private syncGenerationTimeout(options: ConsultationSummaryRequestOptions): number {
    return options.timeoutMs ?? this.transport.defaultTimeoutMs ?? SYNC_GENERATION_TIMEOUT_MS;
  }

  /** `POST /api/v1/consultations/:id/summary` — synchronous; not retried unless the caller supplies `idempotencyKey` (`core/retry.ts`'s non-idempotent-POST rule). */
  async generate(
    consultationId: string,
    request: GenerateSummaryRequest = {},
    options: GenerateSummaryOptions = {},
  ): Promise<ConsultationSummaryResponse> {
    const body: GenerateSummaryRequest = { ...request };
    if (options.idempotencyKey !== undefined) body.idempotencyKey = options.idempotencyKey;
    return this.transport.request<ConsultationSummaryResponse>({
      method: 'POST',
      path: consultationSummaryPath(consultationId),
      body,
      hasIdempotencyKey: Boolean(body.idempotencyKey),
      signal: options.signal,
      timeoutMs: this.syncGenerationTimeout(options),
    });
  }

  /** `POST /api/v1/consultations/:id/summary/pre-summary` — synchronous. */
  async generatePreSummary(
    consultationId: string,
    request: GeneratePreSummaryRequest = {},
    options: ConsultationSummaryRequestOptions = {},
  ): Promise<ConsultationSummaryResponse> {
    return this.transport.request<ConsultationSummaryResponse>({
      method: 'POST',
      path: `${consultationSummaryPath(consultationId)}/pre-summary`,
      body: request,
      hasIdempotencyKey: Boolean(request.idempotencyKey),
      signal: options.signal,
      timeoutMs: this.syncGenerationTimeout(options),
    });
  }

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

  /** `PATCH /api/v1/consultations/:id/summary/:summaryId`. See {@link UpdateSummaryOptions.ifMatch} for this route's current (no-op) OCC status. */
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
   * Reachable from `PENDING_REVIEW` only; a summary that is not pending
   * review is a 409. The gateway compare-and-sets against the summary row's
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
      headers: { 'If-Match': options.ifMatch },
      signal: options.signal,
    });
  }
}
