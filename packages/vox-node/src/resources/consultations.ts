/**
 * Minimal consultation read (id validation for the P0.5 summarization flow
 * NOT consultation CRUD; out of day-1 scope) plus the
 * `.summaries` sub-resource and the context-item WRITE (`addContext`, TASK-800).
 *
 * Backed by `apps/api/src/modules/consultation/consultation.controller.ts`.
 */

import { encodePathSegment } from '../core/url';
import type { Transport } from '../core/transport';
import type { AddContextRequest, ConsultationGetResponse, ContextItemResponse } from '../types/consultation';
import { ConsultationSummariesResource } from './consultation-summaries';

/** Per-call options for {@link ConsultationsResource.get}. */
export interface ConsultationRequestOptions {
  signal?: AbortSignal;
}

/** Options for {@link ConsultationsResource.addContext}. */
export interface AddContextOptions extends ConsultationRequestOptions {
  /**
   * Sent as `X-Context-Schema-Version` — the `ConsultationContextSchemaVersion`
   * id the CALLER built against, from the `contextSchemaVersionId` field of the
   * discovery bundle (`GET /api/v1/tenants/me/context-schema`).
   *
   * **Supply it on every `kindKey` write.** When present, the server validates
   * `payload` against THAT version rather than the tenant's current pin, so a
   * publish landing mid-run never silently upgrades — or breaks — a caller that
   * built against an older declaration. Omitting it means "validate against
   * whatever is pinned right now", which is rarely what a long-lived backend
   * integration wants.
   *
   * The gateway ignores the header entirely when `request.kindKey` is absent.
   *
   * This SDK does not fetch discovery for you — there is no typed
   * business-plane read for `tenants/me/context-schema` yet, so the caller owns
   * reading the bundle and threading its `contextSchemaVersionId` through here.
   */
  contextSchemaVersionId?: string;
}

export class ConsultationsResource {
  /** Consultation-bound summarization — `hope.consultations.summaries.*`. */
  readonly summaries: ConsultationSummariesResource;

  constructor(private readonly transport: Transport) {
    this.summaries = new ConsultationSummariesResource(transport);
  }

  /**
   * `GET /api/v1/consultations/:id`. Throws {@link NotFoundError} (from
   * `core/errors.ts`) both for a genuinely missing id AND for a real id that
   * belongs to a different tenant — HOPE's 404-over-403 tenancy posture. See
   * `NotFoundError`'s own docstring before treating this as "wrong id".
   */
  async get(id: string, options: ConsultationRequestOptions = {}): Promise<ConsultationGetResponse> {
    return this.transport.request<ConsultationGetResponse>({
      path: `consultations/${encodePathSegment(id)}`,
      signal: options.signal,
    });
  }

  /**
   * `POST /api/v1/consultations/:id/context` — add one context item.
   *
   * Two writes behind one method, selected by `request.kindKey`:
   *
   * - **Without `kindKey`** — the legacy path. No schema is consulted; the item
   *   is stored on the substrate its {@link AddContextRequest.type} names.
   * - **With `kindKey`** — the item is declared an instance of a tenant-authored
   *   context kind. A `STRUCTURED` kind's `payload` is validated server-side
   *   against that kind's `fields` sub-schema in the PINNED schema version, then
   *   canonicalised and persisted through the same encrypted `content` column as
   *   every other text-bearing item. Pin the version with
   *   {@link AddContextOptions.contextSchemaVersionId}.
   *
   * `type` is required in BOTH cases — `kindKey` names the tenant's vocabulary,
   * it does not replace the platform item type.
   *
   * **Never retried.** This route accepts no idempotency key (the gateway's DTO
   * declares none, and `forbidNonWhitelisted` would reject one), so a
   * non-idempotent POST is left un-retried by `core/retry.ts#shouldRetry` — a
   * duplicated clinical note is a worse outcome than a surfaced 503.
   *
   * **Credential classes.** Reachable by a user JWT and by an API key holding
   * `consultation:session:write`. A service account CANNOT reach it: the route
   * declares no `@RequiredSvcScopes`, and an absent scope declaration is a
   * deny-by-default 403 for the machine classes.
   *
   * @throws TypeError — locally, before any request is issued, when `payload` is
   * supplied without `kindKey`. The gateway answers that combination with a 400
   * (`'payload' requires 'kindKey'`); it is a programming error, not a server
   * condition, so it is raised here rather than discovered in production — the
   * same reasoning as `admin/admin-resource.ts`'s local `If-Match` validation.
   */
  async addContext(consultationId: string, request: AddContextRequest, options: AddContextOptions = {}): Promise<ContextItemResponse> {
    if (request.payload !== undefined && request.kindKey === undefined) {
      throw new TypeError(
        'addContext: `payload` requires `kindKey` — there is no declared context kind to validate it against. ' +
          'Name the tenant-declared kind, or drop the payload.',
      );
    }

    return this.transport.request<ContextItemResponse>({
      method: 'POST',
      path: `consultations/${encodePathSegment(consultationId)}/context`,
      body: request,
      headers: options.contextSchemaVersionId ? { 'X-Context-Schema-Version': options.contextSchemaVersionId } : undefined,
      signal: options.signal,
    });
  }
}
