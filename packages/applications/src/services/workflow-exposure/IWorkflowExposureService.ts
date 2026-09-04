import {
  InvokeWorkflowRequest,
  WorkflowInvokeResponse,
  WorkflowRunCancelResponse,
  WorkflowRunStatusResponse,
  WorkflowSummaryListResponse,
} from './dto';
import type { WorkflowSchemaDescription } from './workflow-schema-description';

/** Per-invoke context the controller resolves from the request and the service never re-derives. */
export interface InvokeWorkflowOptions {
  /** From the `Idempotency-Key` request header, if present. */
  idempotencyKey?: string;
  /** `request['apiKey'].id` when the caller authenticated with an API key — audit provenance only. */
  apiKeyId?: string;
  /**
   * The consultation this run acts on, **from the URL PATH** — lane A.
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
  /**
   * TASK-864 §3.4 — the response mode the caller asked for, so the service can bound it by the
   * definition's Output `protocols` BEFORE a run is started: `blocking` needs `http`, `stream`
   * needs `http-sse`; `async` is always allowed. A legacy (non-`core`) graph declares nothing
   * and is unrestricted, exactly as before.
   */
  mode?: WorkflowRunResponseMode;
  /** TASK-864 — the trigger kind recorded on the run row (`api invoke` when absent). */
  trigger?: 'api invoke' | 'webhook';
}

/** Which catalogue `list()` should answer — the discovery half of the two exposure planes. */
export interface ListWorkflowOptions {
  /** `true` on a consultation-scoped path, so the catalogue matches what that plane can invoke. */
  consultationBound?: boolean;
}

/** How the caller wants the response delivered (lane A step 7). */
export type WorkflowRunResponseMode = 'async' | 'blocking' | 'stream';

/**
 * The exposure plane's application service: invoke a
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

  /**
   * TASK-864 §3.4 — the INBOUND webhook trigger: `POST /hooks/workflows/{slug}`.
   *
   * Verifies `signature` (an HMAC-SHA256 over `"<timestamp>.<rawBody>"`, `sha256=<hex>`) against
   * the definition's own secret and the replay window, then starts a run exactly as `invoke`
   * does with `trigger: 'webhook'`. Every refusal — unknown slug, no secret issued, bad or stale
   * signature, a Trigger that does not declare the `webhook` kind — is a 404 on the unauthenticated
   * plane, so the route discloses nothing about what a tenant has authored.
   */
  triggerByWebhook(slug: string, input: WebhookTriggerInput): Promise<WorkflowInvokeResponse>;

  /**
   * TASK-864 A7 — the published definition's generated contract (`workflow-schema-description.ts`):
   * input/output component schemas, trigger kinds, protocols, admitted modes and the AsyncAPI
   * fragment for its run events. Same 404 posture as `invoke` — a non-exposable definition is
   * not described either.
   */
  describe(slug: string): Promise<WorkflowSchemaDescription>;

  /**
   * TASK-864 — issue (or rotate) the definition's inbound webhook secret. Returns the RAW secret
   * exactly once; only its reversible ciphertext is persisted. Admin plane, tenant-scoped.
   */
  rotateWebhookSecret(slug: string): Promise<WorkflowWebhookSecretResponse>;
}

/** What the inbound webhook route hands the service — the raw body is what was SIGNED. */
export interface WebhookTriggerInput {
  /** The tenant that owns the secret, resolved by the route from the slug lookup key in the URL. */
  tenantId: string;
  /** The exact request body bytes as a string — never a re-serialized object. */
  rawBody: string;
  /** `X-Hope-Signature: sha256=<hex>`. */
  signature: string | undefined;
  /** `X-Hope-Timestamp`: unix seconds, folded into the signed string to bound replay. */
  timestamp: string | undefined;
  /** `Idempotency-Key`, when the sender retries. */
  idempotencyKey?: string;
}

export interface WorkflowWebhookSecretResponse {
  slug: string;
  /** Shown exactly once. */
  secret: string;
  rotatedAt: string;
  /** The URL an integrator POSTs to. */
  hookUrl: string;
}

export const IWorkflowExposureService = Symbol('IWorkflowExposureService');
