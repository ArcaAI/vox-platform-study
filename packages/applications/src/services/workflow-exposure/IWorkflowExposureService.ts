import {
  InvokeWorkflowRequest,
  WorkflowInvokeResponse,
  WorkflowRunCancelResponse,
  WorkflowRunStatusResponse,
  WorkflowSummaryListResponse,
} from './dto';

/** Per-invoke context the controller resolves from the request and the service never re-derives. */
export interface InvokeWorkflowOptions {
  /** From the `Idempotency-Key` request header, if present. */
  idempotencyKey?: string;
  /** `request['apiKey'].id` when the caller authenticated with an API key — audit provenance only. */
  apiKeyId?: string;
  /**
   * The consultation this run acts on, **from the URL PATH** — TASK-850 lane A.
   *
   * A controller may set this ONLY from a route parameter on a consultation-scoped path
   * (`POST /consultations/:consultationId/workflows/:slug/runs`). It must never be read from a
   * body, a query string or a header: those are all caller-composed, which is precisely the C-8
   * shape this option exists to replace. The service does not trust it either — it re-resolves
   * the id through `IConsultationService.getById` (tenant-scoped ⇒ a foreign or unknown id is a
   * 404) before anything downstream sees it.
   *
   * Presence is what admits the `consultation` palette (`CONSULTATION_BOUND_ALLOWED_PALETTES`);
   * absence keeps the original, unchanged `EXPOSURE_ALLOWED_PALETTES` boundary.
   */
  consultationId?: string;
}

/** Which catalogue `list()` should answer — the discovery half of the two exposure planes. */
export interface ListWorkflowOptions {
  /** `true` on a consultation-scoped path, so the catalogue matches what that plane can invoke. */
  consultationBound?: boolean;
}

/** How the caller wants the response delivered (TASK-850 lane A step 7). */
export type WorkflowRunResponseMode = 'async' | 'blocking' | 'stream';

/**
 * The exposure plane's application service (TASK-722 Task 5): invoke a
 * tenant's published workflow, read a run's live status, cancel it, and list
 * what is invokable.
 *
 * `tenantId` is READ FROM CLS EXCLUSIVELY on every method (S-3) — never
 * accepted as a parameter from a caller-controlled value. Every method maps
 * a foreign-tenant or unpublished `slug`/`runId` to `NotFoundException`
 * (404-over-403, rule 04 §NEVER) — never `ForbiddenException` for that case.
 */
export interface IWorkflowExposureService {
  /** The tenant's published + ACTIVE workflows (slug + identity only — no per-definition input schema exists yet). */
  list(opts?: ListWorkflowOptions): Promise<WorkflowSummaryListResponse>;

  /**
   * Start a run of the tenant's ACTIVE PUBLISHED version of `slug`.
   *
   * Cross-tenant / unpublished / unknown `slug` -> `NotFoundException`.
   * A `WORKFLOW_EXPOSURE_ENABLED` kill-switch OFF -> `NotFoundException` (the
   * surface's existence is not disclosed while gated — same posture as
   * `registration.selfSignupEnabled`). Quota exhausted (`monthlyWorkflowInvocations`)
   * -> `QuotaExceededException` (429). A disallowed cloud-provider selection
   * (decision #6, R-8) -> `ForbiddenException` (403). Repeating the SAME
   * `Idempotency-Key` returns the prior response and starts no second run.
   */
  invoke(slug: string, dto: InvokeWorkflowRequest, opts: InvokeWorkflowOptions): Promise<WorkflowInvokeResponse>;

  /** Live run status + stages. Cross-tenant `runId`, or a `runId` that does not belong to `slug`'s lineage -> `NotFoundException`. */
  getRunStatus(slug: string, runId: string): Promise<WorkflowRunStatusResponse>;

  /** Sends the interpreter's allow-listed `cancel` signal — never a caller-supplied signal name. Same 404 posture as {@link getRunStatus}. */
  cancelRun(slug: string, runId: string): Promise<WorkflowRunCancelResponse>;
}

export const IWorkflowExposureService = Symbol('IWorkflowExposureService');
