/**
 * TASK-933 — the consultation REALTIME lifecycle: opening a consultation,
 * driving its recording, and reading the four live planes it publishes.
 *
 * Everything here is served by
 * `apps/api/src/modules/consultation/consultation.controller.ts`. The types are
 * hand-mirrored from the gateway DTOs (`OpenConsultationRequest`,
 * `ConsultationResponse`, `recording.dto.ts`, `live-summary.dto.ts`,
 * `realtime/dto/section-patch.dto.ts`) rather than generated, exactly like the
 * rest of `src/types/**` — the generated surface in this package is
 * `resources/admin/**` and nothing else.
 *
 * ## The one shape a caller must get right
 *
 * `GET :id/live-summary/stream` is a MULTIPLEXED channel. Three payload kinds
 * ride it, and they are told apart by the `event` field IN THE JSON, never by
 * the SSE `event:` line (the gateway relays every one of them as a default
 * `message` frame). The legacy whole-document snapshot carries no `event` at
 * all, which is why its absence is the discriminator for that arm.
 */

// -----------------------------------------------------------------------------
// open
// -----------------------------------------------------------------------------

/**
 * Body of `POST /api/v1/consultations/open` — the get-or-create entry point.
 * Mirrors `OpenConsultationRequest`
 * (`packages/applications/src/services/consultation/consultation/dto/open-consultation.request.ts`).
 *
 * The gateway validates this body with `whitelist + forbidNonWhitelisted`, so
 * an undeclared field rejects the whole open with a 400 rather than being
 * ignored. This interface is closed on purpose.
 */
export interface OpenConsultationRequest {
  /** The tenant's own patient identifier. Required. */
  patientId: string;
  /**
   * The clinician this consultation belongs to — it lands on
   * `Consultation.doctorId`, and every downstream consumer (DNA writing style,
   * the redaction gate, the doctor's report, prompt tier, audit) reads it from
   * that row rather than from the caller.
   *
   * **Required when this client authenticates as a SERVICE ACCOUNT, and
   * refused when it does not** (TASK-933) — UNLESS the tenant's context schema
   * names a user-identity field and `context` carries it (TASK-950), in which
   * case HOPE resolves (or provisions) the clinician from that value instead
   * and this field may be omitted. A machine has no clinician identity of its
   * own, so it must supply one or the other; a human caller already IS the
   * clinician, and naming a different one would be an impersonation the
   * gateway answers with a 400. A user the tenant does not have — or one that
   * may not own a consultation — is a 404, not a 403: HOPE's cross-tenant
   * posture applies to the id space here as everywhere else.
   *
   * When BOTH this field and the schema's identity value are sent, they MUST
   * agree — a mismatch is a 400 `CLINICIAN_MISMATCH`. A service-account
   * caller that sends neither gets 400 `CLINICIAN_REQUIRED`.
   */
  clinicianUserId?: string;
  /** `YYYY-MM-DD`. Defaults to today server-side. */
  appointmentDate?: string;
  /**
   * The department the visit belongs to. This is what SELECTS the governing
   * workflow (`WorkflowAssignment` resolves DEPARTMENT → TENANT), the
   * department SOAP shape, and the department-scoped context schema — so an
   * integration that omits it gets the tenant-wide default for all three.
   */
  departmentId?: string;
  /**
   * The PRIOR consultation, when this visit is a revisit or a referral.
   * Its presence is the whole of HOPE's visit-type signal: absent ⇒
   * `visit-type:new-visit`, present ⇒ `visit-type:revisit`, and the graph's
   * `n_visit` branch routes on it. There is no separate "visit type" field to
   * send.
   */
  parentConsultationId?: string;
  /**
   * An explicit workflow override, authorized against the tenant's own
   * published `consultation`-palette definitions.
   *
   * **Prefer omitting it.** The department assignment cascade is the intended
   * selector; an override that names a slug this tenant cannot see is a 404
   * and one it may not use to govern a consultation is a 403.
   */
  workflowDefinitionSlug?: string;
  /**
   * BCP-47 tag the generated NOTE is written in (`en`, `ml`, `en-IN`).
   *
   * NOT the STT language — a Malayalam-English consultation is routinely
   * documented in English. Absent means undeclared, which is not "English":
   * the agent's own body decides.
   */
  language?: string;
  /**
   * The consultation-context payload for this open, `{ [kindKey]: payload }`
   * — the same shape as the agent-invocation `context` (TASK-950). It is
   * validated per kind against the DEPARTMENT-effective schema (what
   * {@link TenantsResource.contextSchema} advertises and `vox-codegen --tenant`
   * types); a violation is a 400 `CONTEXT_SCHEMA_VIOLATION` carrying
   * `problems[]`.
   *
   * When the effective schema declares a `userIdentity` field on a kind and
   * this payload carries it, a SERVICE-ACCOUNT caller gets the clinician
   * resolved from that value instead of (or in agreement with)
   * `clinicianUserId` — see that field's doc for the agreement rule. Value
   * problems surface as 400 `USER_IDENTITY_INVALID`, an unresolved
   * department as 400 `USER_IDENTITY_DEPARTMENT_UNRESOLVED`, no match with
   * auto-provisioning disabled for the tenant as 404 `USER_IDENTITY_UNKNOWN`,
   * a match on a user who may not act as clinician as 404
   * `USER_IDENTITY_NOT_USABLE`, more than one match as 409
   * `USER_IDENTITY_AMBIGUOUS`, and a full seat quota as a 409 with the quota
   * error shape. For a JWT or API-key caller the field is validated as
   * ordinary content and otherwise ignored — that caller already IS the
   * clinician.
   *
   * Since TASK-951, a schema may mark up to four MORE roles beside
   * `userIdentity`, each on at most one `STRUCTURED`, `cardinality: 'ONE'`
   * kind's property (`ContextKindDeclaration`), and HOPE MAPS every one of
   * them at `open()` — never merely validates them:
   *
   * - `department: { field, by: 'code' | 'name' }` — resolves the submitted
   *   value against the tenant's own departments (by the unique `code`, or
   *   by `name`, case-insensitively) and SELECTS the consultation's
   *   `departmentId`, exactly as if it had been sent directly. An unknown
   *   value is 404 `DEPARTMENT_UNKNOWN`; more than one `name` match is 400
   *   `DEPARTMENT_AMBIGUOUS`; disagreement with an explicit `departmentId`
   *   on this same request is 400 `DEPARTMENT_MISMATCH`.
   * - `visitType: { field }` — the submitted value (matched through the
   *   platform's visit-type catalogue, aliases included) is recorded on the
   *   consultation and wins over the `parentConsultationId`-derived signal
   *   at every downstream read site. An unmatched value is 400
   *   `VISIT_TYPE_INVALID`.
   * - `externalRef: { field }` — persisted on the consultation's metadata.
   *   NOT part of the get-or-create idempotency key, so it never changes
   *   which row `open()` returns.
   * - `materializeAs: 'CASE_NOTE'` on a kind — every array entry of that
   *   kind's payload is ALSO written as one `CASE_NOTE` context item,
   *   beyond the ordinary PRE context item the kind already becomes, so the
   *   warm-start pre-summary sees client-supplied prior notes without a
   *   separate write.
   *
   * Every validated kind in this payload — marked or not — is persisted as
   * a PRE context item, and the whole payload is threaded into the
   * governing workflow's trigger context (`trigger.context.<kindKey>.*`).
   */
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Response of `POST /api/v1/consultations/open`. Mirrors `ConsultationResponse`.
 *
 * A PARTIAL VIEW in the same spirit as {@link ConsultationGetResponse}: the
 * server DTO additionally carries the `doctor`/`department` expansions and
 * `contextItems`, which this SDK has no reason to model.
 */
export interface ConsultationOpenResponse {
  id: string;
  patientId: string;
  /** The acting clinician — the `clinicianUserId` that was named, for a service-account caller. */
  doctorId: string;
  departmentId?: string;
  /** `YYYY-MM-DD`. */
  appointmentDate: string;
  parentConsultationId?: string;
  status?: string;
  /** As DECLARED at open; absent = undeclared. */
  language?: string;
  metadata?: Record<string, unknown>;
  /** Row `_version` (OCC counter), mirrored onto the response `ETag`. */
  version?: number;
  createdAt: string;
  updatedAt: string;
  /**
   * `true` when this call CREATED the consultation, `false` when it returned
   * an existing one for the same `(patientId, doctorId, appointmentDate)`.
   * Open is get-or-create, so this is the only way to tell.
   */
  isNew?: boolean;
}

// -----------------------------------------------------------------------------
// recording
// -----------------------------------------------------------------------------

/** Body of `POST /api/v1/consultations/:id/recording/start`. */
export interface StartRecordingRequest {
  /**
   * The STT streaming session id from
   * {@link SttResource.createStreamSession}. Supplying it is what lets the live
   * documentation layer subscribe to `stt:result:{sessionId}` directly; omit it
   * and the service falls back to a debounced re-read of accumulated
   * transcript content, which is slower and coarser.
   */
  sessionId?: string;
}

/**
 * One transcript correction the CLINICIAN accepted during the session, carried
 * on stop so the endpoint stage can promote it over the raw transcript.
 * Mirrors `AcceptedCorrectionProposal`.
 */
export interface AcceptedCorrectionProposal {
  proposalId: string;
  /** Offset into the RAW TRANSCRIPT, not the note. */
  start: number;
  /** Exclusive. */
  end: number;
  /** The exact text the span is claimed to cover — re-verified server-side. */
  original: string;
  proposed: string;
  category?: string;
  confidence?: number;
  /** Only `'ACCEPTED'` is promotable; a proposal still `PROPOSED` stays advisory. */
  status: string;
}

/** Body of `POST /api/v1/consultations/:id/recording/stop`. */
export interface StopRecordingRequest {
  /** Persist the last running-summary snapshot as a `PRE_SUMMARY` context item before teardown. */
  persistSnapshot?: boolean;
  /** At most 200 entries server-side. Omit (do not send `[]`) when the clinician accepted nothing. */
  acceptedProposals?: AcceptedCorrectionProposal[];
}

/** Response of both recording routes. Mirrors `RecordingStateResponse`. */
export interface RecordingStateResponse {
  consultationId: string;
  /** Lifecycle status AFTER the transition (`RECORDING` on start; reverted on stop). */
  status: string;
  recording: boolean;
  /** Echoed from the request. */
  sessionId?: string;
  /** Gateway-relative SSE path for the live summary. */
  sseUrl: string;
  updatedAt: string;
}

// -----------------------------------------------------------------------------
// live-summary channel — three payload kinds, one stream
// -----------------------------------------------------------------------------

/** One medical entity, offset-addressed into `runningSummary`. */
export interface LiveSummaryEntity {
  text: string;
  /** Entity class (`MEDICATION`, `CONDITION`, …) or — on `findings` — the tenant instruction's own label. */
  type: string;
  confidence?: number;
  icd10?: string;
  start?: number;
  end?: number;
}

/** A logical section of the running summary. */
export interface LiveSummarySection {
  title: string;
  content: string;
}

/** Structured vitals, accumulated field-wise across flushes. Never fabricated. */
export interface LiveSummaryVitals {
  systolic?: number;
  diastolic?: number;
  heartRate?: number;
  spo2?: number;
  temperatureC?: number;
  weightKg?: number;
}

/** Per-segment groundedness verdict. `unverified` is never presented as verified. */
export interface LiveSummaryGroundednessSegment {
  text: string;
  verdict: 'grounded' | 'ungrounded' | 'unverified';
  score?: number;
  start?: number;
  end?: number;
}

/** Output-side groundedness rollup (`ungrounded` > `unverified` > `grounded`). */
export interface LiveSummaryGroundedness {
  verdict: 'grounded' | 'ungrounded' | 'unverified';
  segments?: LiveSummaryGroundednessSegment[];
  flaggedSpans?: { start: number; end: number }[];
  checkedAt: string;
}

/**
 * The whole-document snapshot — the LEGACY payload of the live-summary channel,
 * and the one that carries no `event` discriminator.
 */
export interface LiveSummaryEvent {
  consultationId: string;
  runningSummary: string;
  sections: LiveSummarySection[];
  entities: LiveSummaryEntity[];
  /** Important findings the TENANT'S own instruction picked out. Absent when no such node runs. */
  findings?: LiveSummaryEntity[];
  lastSegmentId?: string;
  groundedness?: LiveSummaryGroundedness;
  /** Per-flush telemetry (`metadata.stats`, `metadata.agent`) — left open rather than guessed at. */
  metadata?: Record<string, unknown>;
  vitals?: LiveSummaryVitals;
  /** `true` when the last generation FAILED: the content is the last good one, never fabricated. */
  textFailed?: boolean;
  /** Absent = the live-documentation flush loop; `'interpreter'` = a tenant-authored graph. */
  source?: string;
  nodeType?: string;
  ordinal?: number;
  total?: number;
  updatedAt: string;
  /** `true` on the TERMINAL snapshot published when recording stops. */
  closed?: boolean;
}

/** What a {@link SectionPatchEvent} annotation asserts about a span. */
export type SectionAnnotationKind = 'entity' | 'groundedness' | 'flagged' | 'finding';

/** One annotation, addressed LOCALLY into this section's `content`. */
export interface SectionAnnotation {
  kind: SectionAnnotationKind;
  start: number;
  end: number;
  type?: string;
  verdict?: 'grounded' | 'ungrounded' | 'unverified';
  icd10?: string;
  score?: number;
}

/** Where a section's content came from, anchored to transcript segments. */
export interface SectionProvenance {
  transcriptSegmentId?: string;
  transcriptStart?: number;
  transcriptEnd?: number;
}

/**
 * One section's new state, streamed independently of every other section.
 *
 * **Offsets in `annotations` index THIS section's `content`** — never a
 * concatenated document. And the ordering rule is not advisory: DISCARD a patch
 * whose `revision` is not greater than the one you already hold for this
 * `(documentKey, sectionKey)`. Patches may arrive out of order, and a degrade
 * patch deliberately carries `revision: 0` so it can never displace content.
 */
export interface SectionPatchEvent {
  event: 'section.patch';
  consultationId: string;
  /** The tenant's `DocumentTemplate.slug` — WHICH document. */
  documentKey: string;
  sectionKey: string;
  title: string;
  idx: number;
  revision: number;
  /** `empty` renders as a SKELETON, not an error. `confirmed` is clinician-touched and never overwritten. */
  state: 'empty' | 'provisional' | 'confirmed' | 'locked';
  content: string;
  annotations?: SectionAnnotation[];
  provenance?: SectionProvenance[];
  documentTemplateVersionId?: string | null;
  /**
   * PHI-safe reason code present ONLY on a patch reporting a FAILED generation.
   * It is what lets a reader tell "still generating" from "generation failed" —
   * both render as `state: 'empty'`.
   */
  degradeReason?: string;
  updatedAt: string;
}

/** Where the warm start is. `running` is why the panel needs three states, not two. */
export type PreSummaryStatus = 'running' | 'ready' | 'degraded';

/** The warm-start event, riding the same channel as the snapshot and the patches. */
export interface PreSummaryEvent {
  event: 'presummary';
  consultationId: string;
  status: PreSummaryStatus;
  /** The generated pre-summary (Markdown), present on `ready`. */
  content?: string;
  /** PHI-safe code on `degraded` (e.g. `no_case_notes`) — never clinical text. */
  error?: string;
  agentSlug?: string;
  updatedAt: string;
}

/** Everything that can arrive on `GET :id/live-summary/stream`. */
export type LiveSummaryStreamEvent = LiveSummaryEvent | SectionPatchEvent | PreSummaryEvent;

// -----------------------------------------------------------------------------
// the sibling planes
// -----------------------------------------------------------------------------

/**
 * `GET :id/live-assist/stream` — interpreter suggestions and PROPOSED
 * corrections.
 *
 * **CARRIES PHI**: a correction proposal quotes the original span verbatim.
 * Proposal-first by contract: nothing on this feed has been written to any
 * note. The feed has no terminal event — the client closes it.
 *
 * Both branches ride one snapshot, and a publish REPLACES only the branch it
 * carries, leaving the other standing.
 */
export interface LiveAssistEvent {
  consultationId: string;
  tenantId?: string;
  suggestions?: Record<string, unknown>[];
  corrections?: Record<string, unknown>;
  suggestionsNodeType?: string;
  correctionsNodeType?: string;
  provider?: string;
  model?: string;
  updatedAt: string;
}

/** One stage of the harness draft-generation checklist (no PHI). */
export interface HarnessProgressStage {
  [key: string]: unknown;
}

/**
 * `GET :id/harness-progress/stream` — the FULL accumulated stage list on every
 * event (a snapshot fold, so a late joiner is not behind). No PHI. The terminal
 * event carries `closed: true`.
 */
export interface HarnessProgressEvent {
  consultationId: string;
  tenantId?: string;
  jobId?: string;
  total?: number;
  stages: HarnessProgressStage[];
  updatedAt: string;
  closed: boolean;
}

/**
 * `GET :id/loop/stream` — the agentic loop's feed. APPEND-ONLY, unlike the
 * snapshot planes: each event is self-contained, there is no fold, no late-join
 * replay and no terminal event.
 */
export interface LoopEvent {
  consultationId: string;
  tenantId?: string;
  runId?: string;
  /** e.g. `action.started`, `action.completed`, `specialist.dispatched`. */
  kind: string;
  label?: string;
  /** Ids and labels only — no PHI. */
  data?: Record<string, unknown>;
  publishedAt: string;
}
