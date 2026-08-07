/**
 * Minimal consultation read (id validation for the P0.5 summarization flow —
 * NOT consultation CRUD; see the ticket plan §3.4/OD-5) plus the
 * `.summaries` sub-resource. Backed by
 * `apps/api/src/modules/consultation/consultation.controller.ts#getById`.
 */

import { encodePathSegment } from '../core/url';
import type { Transport } from '../core/transport';
import type { ConsultationGetResponse } from '../types/consultation';
import { ConsultationSummariesResource } from './consultation-summaries';

/** Per-call options for {@link ConsultationsResource.get}. */
export interface ConsultationRequestOptions {
  signal?: AbortSignal;
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
}
