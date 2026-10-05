/**
 * `hope.consultations.*` — opening a consultation, driving its recording,
 * reading its live planes, writing context items into it, and taking it to a
 * signed note.
 *
 * Backed by `apps/api/src/modules/consultation/consultation.controller.ts`.
 *
 * TASK-933 grew this from a minimal READ into the realtime LIFECYCLE a machine
 * integration runs: `open` → `recording.start` → `streams.*` →
 * `recording.stop` → `waitForFinalNote` / `summaries.latest` →
 * `summaries.approve` → `close`. Also here: `get`, `chain` (the visit chain
 * this consultation belongs to), `listContext`, `documentSections`,
 * `addContext` and `updateLanguage`. What it is still NOT is consultation
 * CRUD — there is no delete and no listing, because neither is part of running
 * a consultation.
 */

import { FinalNoteTimeoutError, FinalNoteUnavailableError, NotFoundError } from '../core/errors';
import { encodePathSegment } from '../core/url';
import { toStrongValidator } from '../core/if-match';
import type { Transport } from '../core/transport';
import type {
  AddContextRequest,
  ConsultationGetResponse,
  ConsultationStatus,
  ConsultationSummaryResponse,
  ContextItemResponse,
} from '../types/consultation';
import type {
  CloseConsultationRequest,
  DocumentSection,
  OpenConsultationRequest,
  UpdateConsultationLanguageRequest,
} from '../types/consultation-realtime';
import { ConsultationHandle, withLifecycleHeader } from './consultation-handle';
import type { ConsultationOpenResult } from './consultation-handle';
import { ConsultationRecordingResource } from './consultation-recording';
import { ConsultationStreamsResource } from './consultation-streams';
import { ConsultationSummariesResource } from './consultation-summaries';
import { SttResource } from './stt';
import { ConsultationWorkflowsResource } from './workflows';

/** Per-call options for {@link ConsultationsResource.get}. */
export interface ConsultationRequestOptions {
  signal?: AbortSignal;
}

/** Options for {@link ConsultationsResource.waitForFinalNote}. */
export interface WaitForFinalNoteOptions {
  /**
   * The moment the caller stopped recording. Only a note whose `updatedAt` (else `createdAt`) is
   * AFTER this counts — the morning's signed note on the same consultation chain, or a note left
   * by an earlier recording, must never be returned as this visit's final note.
   *
   * Compared against SERVER timestamps, so prefer a server-derived value where you have one (the
   * `updatedAt` of the {@link ConsultationRecordingResource.stop} response) over `new Date()` when
   * the caller's clock may skew from the gateway's.
   */
  since: Date | string;
  /** Give up with {@link FinalNoteTimeoutError} after this long. Default `180000` (3 min). */
  timeoutMs?: number;
  /** Delay between polls. Default `5000`. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Statuses at which the finalize run has produced a note the caller may read.
 *
 * @deprecated Part of the pre-lifecycle twelve-value vocabulary. Read `status` and `processing`
 * (`STOPPED` + `AWAITING_REVIEW`) from a {@link ConsultationHandle}, or watch its `status` events.
 */
const NOTE_READY_STATUSES: ReadonlySet<ConsultationStatus> = new Set<ConsultationStatus>([
  'PENDING_REVIEW',
  'DRAFT_PENDING_SENSORS',
  'SIGNED',
  'CLOSED_COMPLETE',
  'TIMED_OUT',
]);

function parseSince(since: Date | string): number {
  const ms = since instanceof Date ? since.getTime() : Date.parse(since);
  if (Number.isNaN(ms)) {
    throw new TypeError('waitForFinalNote: `since` must be a Date or an ISO-8601 timestamp — it is the baseline a fresh note is measured against.');
  }
  return ms;
}

function noteTime(note: ConsultationSummaryResponse): number {
  const ms = Date.parse(note.updatedAt ?? note.createdAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Sleep that a caller's `AbortSignal` can cut short (rejects with the signal's reason). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Options for {@link ConsultationsResource.close}. */
export interface CloseConsultationOptions extends ConsultationRequestOptions {
  /**
   * Sent as `If-Match`. **REQUIRED** — `POST :id/close` carries
   * `@RequiresIfMatch()` on the gateway, so an omitted header is a
   * guaranteed 428. Pass the strong validator you read the consultation at
   * (e.g. `'"7"'`).
   */
  ifMatch: string | number;
}

/** Options for {@link ConsultationsResource.updateLanguage}. */
export interface UpdateLanguageOptions extends ConsultationRequestOptions {
  /**
   * Sent as `If-Match`. `PATCH :id` carries `@RequiresIfMatch()` on the gateway, so an omitted
   * header is a guaranteed 428 — same rule as {@link CloseConsultationOptions.ifMatch}.
   *
   * **Optional here, unlike `close`'s.** Omit it and {@link ConsultationsResource.updateLanguage}
   * GETs the consultation first to read its current `version` and builds the header from that —
   * one extra round trip. Pass the version/ETag you already hold (e.g. from `open()`/`get()`) to
   * skip it.
   */
  ifMatch?: string | number;
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
   * Read the bundle with `hope.tenants.contextSchema()` and thread its
   * `contextSchemaVersionId` through here; this SDK does not fetch discovery
   * implicitly, because which version a long-lived integration pins is a
   * decision it must make once and keep, not one to re-derive per write.
   */
  contextSchemaVersionId?: string;
}

/** Construction options for {@link ConsultationsResource}. */
export interface ConsultationsResourceOptions {
  /** Used by handles for the direct-to-storage upload, which must carry no gateway credentials. */
  fetch?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. */
  random?: () => number;
}

export class ConsultationsResource {
  /** Consultation-bound summarization — `hope.consultations.summaries.*`. */
  readonly summaries: ConsultationSummariesResource;
  /**
   * Consultation-bound WORKFLOW invocation — `hope.consultations.workflows.*`
   *
   * The clinical plane: a run started here may read and write THIS
   * consultation, and nothing else. The id travels in the URL and is
   * re-resolved server-side against your tenant; it is never accepted in the
   * request body.
   */
  readonly workflows: ConsultationWorkflowsResource;
  /**
   * The RECORDING lifecycle — `hope.consultations.recording.start/stop`.
   *
   * A sub-resource rather than two methods on this class, because the pair is
   * one state machine with one invariant worth keeping visible: an STT
   * streaming session is created FIRST and its id handed to `start`, so the
   * live-documentation layer can subscribe to that session's results directly.
   *
   * @deprecated Use {@link ConsultationHandle.start}, {@link ConsultationHandle.pause} and
   * {@link ConsultationHandle.stop} (from `open()` / `attach()`): they compose the STT session,
   * the start command and the socket, and `stop` waits for the final transcript.
   */
  readonly recording: ConsultationRecordingResource;
  /** The four LIVE SSE planes — `hope.consultations.streams.*` (TASK-933). */
  readonly streams: ConsultationStreamsResource;

  private readonly transport: Transport;
  private readonly handleOptions: ConsultationsResourceOptions;

  /**
   * @param options What the handles `open`/`attach` return need beyond the transport. `HopeClient`
   *   passes its raw `fetch`, which the direct-to-storage attachment upload uses so no gateway
   *   credential reaches the storage host; unset, the global `fetch` is used.
   */
  constructor(transport: Transport, isServiceAccount = false, options: ConsultationsResourceOptions = {}) {
    // Every consultation call asks for the real seven-value status.
    this.transport = withLifecycleHeader(transport);
    this.handleOptions = options;
    this.summaries = new ConsultationSummariesResource(transport);
    this.workflows = new ConsultationWorkflowsResource(transport, isServiceAccount);
    this.recording = new ConsultationRecordingResource(transport);
    this.streams = new ConsultationStreamsResource(transport);
  }

  /**
   * `POST /api/v1/consultations/open` — GET-OR-CREATE the consultation for one
   * VISIT, and return the {@link ConsultationHandle} that drives it: the open response's fields
   * (read-only, plus the lifecycle ones — `processing`, `reopenCount`, `encounters`, …) and the
   * verbs `start`, `pause`, `stop`, `generateSummary`, `approve`, `close`, `reopen`,
   * `sendAttachment`, `sendFeedback` and `history`.
   *
   * **The open key.** A consultation is an EPISODE of encounters (e.g. doctor →
   * tests → doctor). Without an `externalRef` it is the non-closed consultation
   * for `(clinician, patient, department)`; a `revisit` open after the current
   * encounter ended appends encounter 2 to it. With an `externalRef` (the value
   * of the schema's `externalRef`-marked context field, e.g. an EMR encounter id)
   * the ref selects the ENCOUNTER: the same ref returns the same consultation, a
   * new ref appends an encounter to the open one. With no open consultation, a
   * new one is created and chained to the latest closed one as its parent.
   *
   * Read `isNew` / `encounterAppended` on the handle to tell which happened;
   * calling this twice for the same visit is the intended way to re-attach to a
   * consultation you already opened, not an error. **Then read `recordable`**
   * before recording: an approved or closed consultation is returned as-is with
   * `recordable: false`.
   *
   * **A service-account caller MUST name the clinician — either
   * `clinicianUserId`, or the schema's user-identity field inside `context`
   * (TASK-950) — and a human caller must not name one at all** (TASK-933).
   * The named clinician lands on `Consultation.doctorId` and is what every
   * downstream consumer reads — the DNA writing style, the redaction gate,
   * the doctor's report, the prompt tier and the audit trail. A machine is
   * never recorded as the clinician; it is recorded as the ACTOR, beside the
   * clinician it acted for.
   *
   * The other three identity details all matter at open and only at open:
   * `departmentId` selects the governing workflow and the department's SOAP
   * shape, `parentConsultationId` (or a server-derived same-day parent) IS the
   * visit-type signal (none = new visit, present = revisit), and `language` declares what is SPOKEN (a code-switch
   * mode such as `ml-en` is accepted) — it does not choose the note's language,
   * which is the tenant's configured output language or the platform default.
   * None of them can be supplied later.
   *
   * **Never retried.** The route accepts no idempotency key, and get-or-create
   * makes a retry harmless in principle — but `core/retry.ts` does not retry a
   * bare POST, and this method does not special-case itself out of that rule.
   *
   * @throws ConflictError — 409 `EXTERNAL_REF_CONFLICT` when the `externalRef`
   * is already bound to a different patient.
   * @throws BadRequestError — 400 `PARENT_PATIENT_MISMATCH` when
   * `parentConsultationId` belongs to another patient.
   * @throws TypeError — locally, before any request is issued, for an empty
   * `patientId`. The gateway answers that with a 400; it is a programming
   * error, not a server condition.
   */
  async open<TContext extends Record<string, unknown> = Record<string, unknown>>(
    request: OpenConsultationRequest<TContext>,
    options: ConsultationRequestOptions = {},
  ): Promise<ConsultationHandle> {
    if (typeof request.patientId !== 'string' || request.patientId.trim() === '') {
      throw new TypeError('open: `patientId` is required and must be a non-empty string — a consultation is always about a patient.');
    }

    const response = await this.transport.request<ConsultationOpenResult>({
      method: 'POST',
      path: 'consultations/open',
      body: request,
      signal: options.signal,
    });
    return this.handleFor(response);
  }

  /**
   * Build a {@link ConsultationHandle} for a consultation you did not open in this process — a
   * worker picking up a visit, a second service reading history. Reads the consultation once
   * (`GET /api/v1/consultations/:id`); a missing id and another tenant's id are both a 404.
   *
   * The handle's `visitType`, `externalRef` and `governingRun` are whatever the gateway returns on
   * a read; call {@link open} instead when you need the open-time answers (`recordable`,
   * `encounterAppended`).
   */
  async attach(id: string, options: ConsultationRequestOptions = {}): Promise<ConsultationHandle> {
    const response = await this.transport.request<ConsultationOpenResult>({
      path: `consultations/${encodePathSegment(id)}`,
      signal: options.signal,
    });
    return this.handleFor(response);
  }

  private handleFor(response: ConsultationOpenResult): ConsultationHandle {
    return new ConsultationHandle(response, {
      transport: this.transport,
      stt: new SttResource(this.transport),
      fetch: this.handleOptions.fetch,
      sleep: this.handleOptions.sleep,
      random: this.handleOptions.random,
    });
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
   * `GET /api/v1/consultations/:id/chain` — the visit chain this consultation belongs to: the
   * consultation, its ancestors and its children (a same-day return visit is a child of the
   * morning visit), in the order the gateway returns them, tenant-filtered.
   *
   * Gated by the `HISTORY_RETRIEVAL` consent purpose. A service account needs
   * `svc:consultation:session:read`. A missing id and another tenant's id are both a 404.
   */
  async chain(id: string, options: ConsultationRequestOptions = {}): Promise<ConsultationGetResponse[]> {
    return this.transport.request<ConsultationGetResponse[]>({
      path: `consultations/${encodePathSegment(id)}/chain`,
      signal: options.signal,
    });
  }

  /**
   * Wait for the FINAL note of a recording you just stopped — one written after `since`.
   *
   * Polls `summaries.latest` and `get` together. Resolves with the latest summary only when it is
   * NEWER than {@link WaitForFinalNoteOptions.since} **and** the consultation status is one of
   * `PENDING_REVIEW`, `DRAFT_PENDING_SENSORS`, `SIGNED`, `CLOSED_COMPLETE` or `TIMED_OUT`. That
   * baseline is the point: on a consultation that already carries a note (a re-recorded visit), a
   * bare `summaries.latest` poll returns the OLD note immediately and the caller ships stale
   * content as if it were the new one.
   *
   * A 404 from `summaries.latest` means "no note yet" and keeps polling.
   *
   * Requires `consultation:report:read` (service account: `svc:consultation:report:read`) for
   * `summaries.latest` and `consultation:session:read` for `get`.
   *
   * @throws FinalNoteUnavailableError — the consultation reached `CLOSED_INCOMPLETE` without a
   * note newer than `since`; nothing further will be written.
   * @throws FinalNoteTimeoutError — no fresh note within `timeoutMs`. The note may still land;
   * call again or read `summaries.latest` later.
   * @throws TypeError — locally, for an unparseable `since`.
   * @throws The signal's reason (an `AbortError` by default) when `signal` aborts.
   *
   * @deprecated Use {@link ConsultationHandle.stop} (it waits for the final transcript) with
   * {@link ConsultationHandle.generateSummary}`({ wait: true })`, or watch the handle's `status`
   * events for `processing` to reach `AWAITING_REVIEW`.
   */
  async waitForFinalNote(id: string, options: WaitForFinalNoteOptions): Promise<ConsultationSummaryResponse> {
    const sinceMs = parseSince(options.since);
    const timeoutMs = options.timeoutMs ?? 180_000;
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    const { signal } = options;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (signal?.aborted) throw abortReason(signal);

      const [latest, consultation] = await Promise.all([
        this.summaries.latest(id, { signal }).catch((error: unknown) => {
          if (error instanceof NotFoundError) return null;
          throw error;
        }),
        this.get(id, { signal }),
      ]);

      const status = consultation.status;
      const fresh = latest !== null && latest !== undefined && noteTime(latest) > sinceMs;
      if (fresh && status !== undefined && (NOTE_READY_STATUSES.has(status) || status === 'CLOSED_INCOMPLETE')) {
        return latest;
      }
      if (status === 'CLOSED_INCOMPLETE') throw new FinalNoteUnavailableError(id, status);

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new FinalNoteTimeoutError(id, timeoutMs);
      await abortableSleep(Math.min(pollIntervalMs, remaining), signal);
    }
  }

  /**
   * `GET /api/v1/consultations/:id/context` — read back every context item written on this
   * consultation, in the order the gateway returns them (`ContextItemRepository.findAll`
   * ordering — not schema-sorted, not chronologically guaranteed beyond that).
   *
   * Pairs with {@link addContext}: `listContext` is how a caller confirms what it sent actually
   * landed, and reads each item's {@link ContextItemResponse.kindKey} /
   * {@link ContextItemResponse.contextSchemaVersionId} back — fields `addContext`'s own response
   * never carried before the gateway's DTO mapper projected them.
   *
   * **Scopes.** A service account needs `svc:consultation:session:read` — the same scope
   * `recording.start`/`stop` require, not the report-tier scope `documentSections` needs.
   */
  async listContext(consultationId: string, options: ConsultationRequestOptions = {}): Promise<ContextItemResponse[]> {
    return this.transport.request<ContextItemResponse[]>({
      path: `consultations/${encodePathSegment(consultationId)}/context`,
      signal: options.signal,
    });
  }

  /**
   * `GET /api/v1/consultations/:id/documents/sections` — the consultation's clinical document(s)
   * as PERSISTED SECTIONS, in render order.
   *
   * ## Why you want this and not the summary text
   *
   * The live SSE lane's `runningSummary` is the section bodies CONCATENATED — it exists to be the
   * offset base the entity spans index, so it carries no titles and no keys. Reading the note back
   * out of it means re-partitioning prose that was already partitioned server-side. These rows are
   * the partition: `sectionKey`, `title`, `idx`, `state` and the body, exactly as the template
   * declares them. It is also the DURABLE view — `section.patch` only emits while a flush is
   * running, so a client that reloads mid-encounter reads its state here.
   *
   * ## Which of the two routes this calls
   *
   * Without `documentKey`, the DISCOVERY read: every section of EVERY document, ordered by
   * `(documentKey, idx)` — alphabetical by document, render order within it. Nothing else in the
   * API enumerates the document keys, so this is how a client that holds none finds them.
   *
   * With `documentKey`, the narrow read: that one document's sections, `idx` ascending. Use it once
   * you know the key and want one document's worth of rows.
   *
   * A consultation whose documents have not been written yet is an EMPTY ARRAY, not a 404. A 404
   * means the consultation itself is missing — or belongs to another tenant, which HOPE answers
   * the same way (404-over-403; see {@link NotFoundError}).
   *
   * **Scopes.** A service account needs `svc:consultation:report:read`. (An API key needs the
   * corresponding `consultation:report:read`; a user JWT is governed by consultation visibility.)
   * This is a REPORT-tier read, not a session-tier one: `svc:consultation:session:write` — what
   * `open` and `recording.*` require — does NOT reach it, and an integration that holds only the
   * session scope gets a 403 here.
   *
   * Each item carries `version`, which is the value that section's PATCH route requires as its
   * `If-Match`; do not send `revision` there.
   */
  async documentSections(consultationId: string, documentKey?: string, options: ConsultationRequestOptions = {}): Promise<DocumentSection[]> {
    const base = `consultations/${encodePathSegment(consultationId)}/documents`;
    return this.transport.request<DocumentSection[]>({
      path: documentKey === undefined ? `${base}/sections` : `${base}/${encodePathSegment(documentKey)}/sections`,
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
   * **Credential classes.** Reachable by a user JWT, by an API key holding
   * `consultation:session:write`, and — since TASK-933 — by a SERVICE ACCOUNT
   * holding `svc:consultation:session:write`. The earlier text here said a
   * service account could not reach it, which was true of the route as it stood:
   * it declared no `@RequiredSvcScopes`, and an absent scope declaration is a
   * deny-by-default 403 for both machine classes. The realtime plane declared
   * them.
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

  /**
   * `POST /api/v1/consultations/:id/close` — the bookend to {@link open}
   * (TASK-972).
   *
   * Legal from `SIGNED` (→ `CLOSED_COMPLETE`) or `TIMED_OUT` (→ `CLOSED_INCOMPLETE`) —
   * `summaries.approve()` must succeed first on a `PENDING_REVIEW` consultation; an already-closed
   * consultation is returned unchanged; any other state is a 409. The gateway compare-and-sets against
   * the consultation row's `_version` — see {@link CloseConsultationOptions.ifMatch}.
   *
   * `close` is real and OCC-guarded at the gateway today — the **browser**
   * SDK's `useArcaSession().close()` already calls it. What was missing was
   * this wrapper, not the capability.
   *
   * @deprecated Use {@link ConsultationHandle.close}, which sends the handle's own version as
   * `If-Match` and re-reads once on a 412. This `(id, request, { ifMatch })` signature is removed
   * in the release after next.
   */
  async close(consultationId: string, request: CloseConsultationRequest = {}, options: CloseConsultationOptions): Promise<ConsultationGetResponse> {
    return this.transport.request<ConsultationGetResponse>({
      method: 'POST',
      path: `consultations/${encodePathSegment(consultationId)}/close`,
      body: request,
      headers: { 'If-Match': toStrongValidator(options.ifMatch) },
      signal: options.signal,
    });
  }

  /**
   * `PATCH /api/v1/consultations/:id` — change the consultation's declared spoken-language mode
   * after open (TASK-1004 OD-2: a language change made mid-visit updates the CONSULTATION default,
   * so later recordings, batch jobs and workflow runs on it inherit the new mode; it does not touch
   * a session already in progress).
   *
   * OCC — see {@link UpdateLanguageOptions.ifMatch}: pass the version you already hold, or omit it
   * and this method reads the consultation first to get one.
   */
  async updateLanguage(
    consultationId: string,
    request: UpdateConsultationLanguageRequest,
    options: UpdateLanguageOptions = {},
  ): Promise<ConsultationGetResponse> {
    const ifMatch = options.ifMatch ?? (await this.get(consultationId, { signal: options.signal })).version;
    if (ifMatch === undefined) {
      throw new TypeError(
        `updateLanguage: consultation ${consultationId} has no \`version\` to build \`If-Match\` from — pass options.ifMatch explicitly.`,
      );
    }
    return this.transport.request<ConsultationGetResponse>({
      method: 'PATCH',
      path: `consultations/${encodePathSegment(consultationId)}`,
      body: request,
      headers: { 'If-Match': toStrongValidator(ifMatch) },
      signal: options.signal,
    });
  }
}
