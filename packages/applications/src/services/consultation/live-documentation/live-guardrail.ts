/**
 * TASK-1050 W2g — what the LIVE lane does with a guardrail decision (README §9.7.2–§9.7.4, §9.8.1).
 *
 * Guardrail decides, TEXT enforces the generation, the gateway records. The live lane is a CALLER of
 * TEXT, so its part is narrow and every rule it applies lives here, pure:
 *
 *   - it CORRELATES each call: `X-Hope-Consultation-Id`, `X-Hope-Item-Id` (the PRE_SUMMARY snapshot
 *     item the flush writes) and `X-Hope-Run-Key` when one exists, plus `region_items` — the context
 *     items behind each data region, at the version sent (§9.7.4);
 *   - it RELAYS the notices TEXT returns (a 200's `guardrail_notices`, a 422 block's
 *     `guardrailNotice`, a 503 redaction hold's `guardrailNotice`) on the live-summary channel as a
 *     `guardrail.notice` frame, ONCE per `(consultation, checkId, itemId, policyVersion)` (§9.7.3,
 *     OD-15) — a 20 s flush cadence re-screens the same windows and must not repeat a popup;
 *   - it EXCLUDES from its composer what the record says must not reach a model again, through the
 *     SHARED keep predicate `guardrailKeepFilter` (W2e): a WITHHELD item always, a BLOCKED item once
 *     its notice was resolved `item_excluded` (§9.7.5).
 *
 * It never WRITES the hold or an item's `guardrailStatus` marker: both are the gateway ingest's
 * (lane W2e), written from the guardrail evaluation. The lane only READS the consultation's
 * `processingReason` each tick and stands down while it names a hold.
 *
 * Nothing here carries content: notices are PHI-free by contract, and the keys are ids.
 */
import {
  EGRESS_REDACTION_UNAVAILABLE_REASON,
  GUARDRAIL_BLOCKED_PROBLEM_TYPE,
  GUARDRAIL_CORRELATION_HEADERS,
  GUARDRAIL_HOLD_REASON,
  GUARDRAIL_NOTICE_TYPES,
  type GuardrailEvaluationItemRef,
  type GuardrailHoldProcessingReason,
  type GuardrailNotice,
} from '@arcaai/types';

/**
 * TASK-1049 F7 — the ONE data region that carries the live lane's own previous note.
 *
 * The note is the lane's OWN output: TEXT's output gate screened it when it was generated, and it is
 * rewritten every flush, so re-screening it inbound costs ~2–3 judge windows a flush that can never
 * hit the window cache. It therefore travels under exactly this key — nothing else does — so the
 * guardrail's not-judged region list (`medicalJudgeConfigRegions`, `core/policy.py`) can name it.
 */
export const LIVE_SELF_NOTE_REGION_KEY = 'current_note';

/** The region the transcript window travels under (its segment items are its `region_items`). */
export const LIVE_TRANSCRIPT_REGION_KEY = 'transcript';

/** The region the clinician's notes / labs / files travel under. */
export const LIVE_CLINICIAN_NOTES_REGION_KEY = 'clinician_notes';

/** The region a translate-only retry's section text travels under (the snapshot's own content). */
export const LIVE_SECTION_TEXT_REGION_KEY = 'section_text';

/** The live-summary channel frame a notice travels in (a named SSE frame, `tagFrameTypeFromPayload`). */
export const LIVE_GUARDRAIL_NOTICE_EVENT = 'guardrail.notice';

/** The SSE frame: the notice verbatim (no content, fixed message), the consultation, when it was relayed. */
export interface LiveGuardrailNoticeFrame {
  readonly event: typeof LIVE_GUARDRAIL_NOTICE_EVENT;
  readonly consultationId: string;
  readonly notice: GuardrailNotice;
  readonly updatedAt: string;
}

export interface LiveCorrelation {
  readonly consultationId: string;
  /** The PRE_SUMMARY snapshot item this flush writes; absent until the first durable write. */
  readonly itemId?: string | null;
  /** The live agent's `AiActivityRun.runKey`, when one is known before the call. */
  readonly runKey?: string | null;
}

/** The `X-Hope-*` correlation headers for one live TEXT call. Unknown fields are omitted, never sent empty. */
export function liveCorrelationHeaders(correlation: LiveCorrelation): Record<string, string> {
  const headers: Record<string, string> = {};
  if (correlation.consultationId) headers[GUARDRAIL_CORRELATION_HEADERS.consultationId] = correlation.consultationId;
  if (correlation.itemId) headers[GUARDRAIL_CORRELATION_HEADERS.itemId] = correlation.itemId;
  if (correlation.runKey) headers[GUARDRAIL_CORRELATION_HEADERS.runKey] = correlation.runKey;
  return headers;
}

/** Region key → the context items behind it, at the version sent. */
export type LiveRegionItems = Readonly<Record<string, readonly GuardrailEvaluationItemRef[]>>;

/** The `region_items` body field: empty regions dropped, `undefined` when none is left. */
export function regionItemsWire(items: LiveRegionItems | null | undefined): Record<string, GuardrailEvaluationItemRef[]> | undefined {
  if (!items) return undefined;
  const wire: Record<string, GuardrailEvaluationItemRef[]> = {};
  for (const [key, refs] of Object.entries(items)) {
    if (refs.length > 0) wire[key] = refs.map(({ itemId, itemVersion }) => ({ itemId, itemVersion }));
  }
  return Object.keys(wire).length > 0 ? wire : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Enough of the contract to relay a notice: an id, a known type, a message key. TEXT validated the rest. */
function isNotice(value: unknown): value is GuardrailNotice {
  return (
    isRecord(value) &&
    typeof value.noticeId === 'string' &&
    value.noticeId.length > 0 &&
    (GUARDRAIL_NOTICE_TYPES as readonly unknown[]).includes(value.type) &&
    typeof value.messageKey === 'string'
  );
}

/** The notices on a TEXT 200 body (`guardrail_notices`, or the gateway's camel-cased `guardrailNotices`). */
export function textResponseNotices(data: unknown): GuardrailNotice[] {
  if (!isRecord(data)) return [];
  const raw = data.guardrail_notices ?? data.guardrailNotices;
  return Array.isArray(raw) ? raw.filter(isNotice) : [];
}

/** A TEXT refusal that is a guardrail STOP: the hold it implies, its notice, its evaluation ids. */
export interface LiveGuardrailStop {
  readonly reason: GuardrailHoldProcessingReason;
  readonly notice: GuardrailNotice | null;
  readonly evaluationIds: readonly string[];
}

/**
 * Is this TEXT failure a guardrail stop? A 422 whose body is the guardrail-blocked problem, or a 503
 * `EGRESS_REDACTION_UNAVAILABLE` (the cloud pseudonymiser's privacy hold). Anything else is an ordinary
 * failure the flush already degrades on.
 */
export function textGuardrailStop(error: unknown): LiveGuardrailStop | null {
  if (!isRecord(error)) return null;
  const response = isRecord(error.response) ? error.response : null;
  const body = response && isRecord(response.data) ? response.data : null;
  if (!body) return null;
  const notice = isNotice(body.guardrailNotice) ? body.guardrailNotice : null;
  const evaluationIds = Array.isArray(body.guardrailEvaluationIds)
    ? body.guardrailEvaluationIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (response?.status === 422 && body.type === GUARDRAIL_BLOCKED_PROBLEM_TYPE) return { reason: GUARDRAIL_HOLD_REASON, notice, evaluationIds };
  if (body.error_code === EGRESS_REDACTION_UNAVAILABLE_REASON || body.processing_reason === EGRESS_REDACTION_UNAVAILABLE_REASON) {
    return { reason: EGRESS_REDACTION_UNAVAILABLE_REASON, notice, evaluationIds };
  }
  return null;
}

/**
 * The dedupe keys of one notice: one per `(consultation, checkId, itemId, policyVersion)`. A notice
 * is new while ANY of its keys is. A notice with no checks (the redaction hold) is keyed by its
 * message key; one with no items by the empty item.
 */
export function noticeDedupeKeys(notice: GuardrailNotice, consultationId: string): string[] {
  const checks = notice.checks.length > 0 ? notice.checks.map((check) => check.checkId as string) : [notice.messageKey];
  const items = notice.itemIds.length > 0 ? notice.itemIds : [''];
  const keys: string[] = [];
  for (const checkId of checks) for (const itemId of items) keys.push(`${consultationId}|${checkId}|${itemId}|${notice.policyVersion}`);
  return keys;
}

/** The PHI-free record of a relayed notice kept on the snapshot's `_metadata.guardrailNotices`. */
export interface LiveNoticeRecord {
  readonly noticeId: string;
  readonly type: GuardrailNotice['type'];
  readonly messageKey: GuardrailNotice['messageKey'];
  readonly checkIds: readonly string[];
  readonly itemIds: readonly string[];
  readonly policyVersion: string;
  readonly occurredAt: string;
}

export function liveNoticeRecord(notice: GuardrailNotice): LiveNoticeRecord {
  return {
    noticeId: notice.noticeId,
    type: notice.type,
    messageKey: notice.messageKey,
    checkIds: notice.checks.map((check) => check.checkId),
    itemIds: [...notice.itemIds],
    policyVersion: notice.policyVersion,
    occurredAt: notice.occurredAt,
  };
}

export interface LiveExclusionSet {
  /** Context item ids the composer must leave out. */
  readonly itemIds: ReadonlySet<string>;
  /** The `segmentKey`s (`<sttSessionId>:<utteranceIndex>`) of the excluded TRANSCRIPT_SEGMENT items. */
  readonly segmentKeys: ReadonlySet<string>;
}

export const EMPTY_LIVE_EXCLUSION: LiveExclusionSet = Object.freeze({ itemIds: new Set<string>(), segmentKeys: new Set<string>() });

/**
 * The composer exclusion of one flush: the flagged items the SHARED keep predicate rejects
 * (`guardrailKeepFilter`, `guardrail-notice/guardrail-item-exclusion.ts` — WITHHELD always, BLOCKED once
 * resolved `item_excluded`), as item ids and, for transcript segments, their `segmentKey`s.
 */
export function liveExclusionSet(
  items: readonly { readonly id: string; readonly guardrailStatus?: string | null; readonly segmentKey?: string | null }[],
  keep: (item: { id: string; guardrailStatus?: string | null }) => boolean,
): LiveExclusionSet {
  const itemIds = new Set<string>();
  const segmentKeys = new Set<string>();
  for (const item of items) {
    if (keep({ id: item.id, guardrailStatus: item.guardrailStatus ?? null })) continue;
    itemIds.add(item.id);
    if (item.segmentKey) segmentKeys.add(item.segmentKey);
  }
  return { itemIds, segmentKeys };
}
