/**
 * TASK-1050 W3b — the console's reading of a `GuardrailNotice` v1 (`@arcaai/types`, README §9.7.3).
 *
 * A notice is PHI-free by contract: check ids, categories, a fixed `messageKey`, and a
 * `defaultMessage` that is EXACTLY that key's fixed label. The console does not take that on trust:
 * {@link toGuardrailNotice} refuses any notice whose text is not the label, and every surface renders
 * {@link guardrailNoticeCopy} — copy keyed by `messageKey` — never the producer's string.
 *
 * Pure: no React, no I/O. Shared by the playgrounds, the run traces and consultation details
 * (features never import each other; `shared/` is the sanctioned seam).
 */
import {
  GUARDRAIL_CHECK_IDS,
  GUARDRAIL_HOLD_RESOLUTIONS,
  GUARDRAIL_NOTICE_DEFAULT_MESSAGES,
  GUARDRAIL_NOTICE_MESSAGE_KEYS,
  GUARDRAIL_NOTICE_TYPE_ACTION,
  GUARDRAIL_NOTICE_TYPES,
  type GuardrailNotice,
  type GuardrailNoticeMessageKey,
  type HoldResolution,
} from '@arcaai/types';

export type { GuardrailNotice, HoldResolution } from '@arcaai/types';

/**
 * Checks whose PLATFORM floor is `block` — catalogue-locked at block, so the `acknowledged` override
 * is never offered (README OD-9, OD-18; the gateway's `hasBlockFloor`). Mirrors the locked-at-block
 * rows of `apps/guardrail/.../contracts/availability-catalogue.json`; `notice.task1050.test.ts`
 * pins the two together.
 */
export const BLOCK_FLOOR_CHECK_IDS: readonly string[] = Object.freeze(['medical_validation']);

const NOT_MEDICAL_KEY: GuardrailNoticeMessageKey = 'guardrail.blocked.not_medical';
const REDACTION_UNAVAILABLE_KEY: GuardrailNoticeMessageKey = 'guardrail.blocked.redaction_unavailable';

const TYPES: ReadonlySet<string> = new Set(GUARDRAIL_NOTICE_TYPES);
const KEYS: ReadonlySet<string> = new Set(GUARDRAIL_NOTICE_MESSAGE_KEYS);
const CHECK_IDS: ReadonlySet<string> = new Set(GUARDRAIL_CHECK_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `value` as a renderable notice, or `null`. Enforces the contract's cross-field rules — the type's one
 * action, a key of that type, `defaultMessage` exactly its key's label, known check ids — and is lenient
 * about fields a newer server adds (a stored notice carries `status`, `acknowledgement`, …).
 */
export function toGuardrailNotice<T extends GuardrailNotice = GuardrailNotice>(value: unknown): T | null {
  if (!isRecord(value)) return null;
  const { noticeId, type, action, messageKey, defaultMessage, checks, itemIds } = value;
  if (typeof noticeId !== 'string' || noticeId === '') return null;
  if (typeof type !== 'string' || !TYPES.has(type)) return null;
  if (action !== GUARDRAIL_NOTICE_TYPE_ACTION[type as GuardrailNotice['type']]) return null;
  if (typeof messageKey !== 'string' || !KEYS.has(messageKey) || !messageKey.startsWith(`${type}.`)) return null;
  if (defaultMessage !== GUARDRAIL_NOTICE_DEFAULT_MESSAGES[messageKey as GuardrailNoticeMessageKey]) return null;
  if (!Array.isArray(checks) || !checks.every((check) => isRecord(check) && typeof check.checkId === 'string' && CHECK_IDS.has(check.checkId)))
    return null;
  if (!Array.isArray(itemIds) || !itemIds.every((id) => typeof id === 'string')) return null;
  return value as unknown as T;
}

/** The notices of a list or of a body (`guardrailNotices`, TEXT's `guardrail_notices`, or a `notices` list). Invalid entries are dropped. */
export function toGuardrailNotices<T extends GuardrailNotice = GuardrailNotice>(value: unknown): T[] {
  const list = Array.isArray(value) ? value : isRecord(value) ? (value.guardrailNotices ?? value.guardrail_notices ?? value.notices) : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const notice = toGuardrailNotice<T>(entry);
    return notice ? [notice] : [];
  });
}

/** The copy to render: the fixed label of `messageKey` (clients localise on the key, README §9.7.3). */
export function guardrailNoticeCopy(notice: Pick<GuardrailNotice, 'messageKey'>): string {
  return GUARDRAIL_NOTICE_DEFAULT_MESSAGES[notice.messageKey] ?? GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'];
}

/** A warning or an unverified check — warn weight, never a stop (README §9.8.1). */
export function isWarningNotice(notice: Pick<GuardrailNotice, 'type'>): boolean {
  return notice.type === 'guardrail.warning' || notice.type === 'guardrail.unverified';
}

export function isBlockedNotice(notice: Pick<GuardrailNotice, 'type'>): boolean {
  return notice.type === 'guardrail.blocked';
}

export function isRedactionUnavailableNotice(notice: Pick<GuardrailNotice, 'messageKey'>): boolean {
  return notice.messageKey === REDACTION_UNAVAILABLE_KEY;
}

/**
 * Merge `incoming` into `current`, one notice per `noticeId`, in first-seen order. A repeat REPLACES
 * the earlier entry (its state may have moved). Returns `current` itself when nothing changed, so a
 * React state setter bails out of a re-render.
 */
export function mergeGuardrailNotices<T extends GuardrailNotice>(current: readonly T[], incoming: readonly T[]): readonly T[] {
  let next: T[] | undefined;
  for (const notice of incoming) {
    const list = next ?? [...current];
    const index = list.findIndex((existing) => existing.noticeId === notice.noticeId);
    if (index === -1) {
      list.push(notice);
      next = list;
    } else if (JSON.stringify(list[index]) !== JSON.stringify(notice)) {
      list[index] = notice;
      next = list;
    }
  }
  return next ?? current;
}

/** The keys one notice occupies for the per-check toast dedupe: its checks, or its key when it has none. */
function dedupeKeysOf(notice: GuardrailNotice): string[] {
  return notice.checks.length > 0 ? notice.checks.map((check) => check.checkId) : [notice.messageKey];
}

export interface NoticeDeduper {
  /** True the first time any of the notice's checks is seen in `scope` (a consultation id). */
  firstSeen: (scope: string, notice: GuardrailNotice) => boolean;
}

/**
 * OD-15 — a live summary re-screens the same windows every few seconds, and the server mints one notice
 * per `(consultation, check, item, policyVersion)`; the clinician must still not get a toast per tick or
 * per item. This keeps ONE toast per check per consultation. Badges and lists are not deduped this way:
 * they show every notice, deduplicated by `noticeId` ({@link mergeGuardrailNotices}).
 */
export function createNoticeDeduper(): NoticeDeduper {
  const seen = new Set<string>();
  return {
    firstSeen(scope, notice) {
      let fresh = false;
      for (const key of dedupeKeysOf(notice)) {
        const scoped = `${scope}|${key}`;
        if (!seen.has(scoped)) {
          seen.add(scoped);
          fresh = true;
        }
      }
      return fresh;
    },
  };
}

/** True when any check behind the notice has a platform floor of `block` (the gateway's `hasBlockFloor`). */
export function hasBlockFloor(notice: Pick<GuardrailNotice, 'messageKey' | 'checks'>): boolean {
  if (notice.messageKey === NOT_MEDICAL_KEY) return true;
  return notice.checks.some((check) => BLOCK_FLOOR_CHECK_IDS.includes(check.checkId));
}

/**
 * The resume resolutions to OFFER for a hold (README §9.7.5, §9.8.1, OD-18). Every safety hold offers
 * `item_excluded` and `item_edited`; `acknowledged` (the override) only below a block floor, so the
 * locked medical check never offers it. The egress-redaction hold is a privacy outage, not a verdict —
 * there is nothing to exclude or edit, so it offers the retry only.
 */
export function allowedHoldResolutions(notice: Pick<GuardrailNotice, 'type' | 'resumable' | 'messageKey' | 'checks'>): HoldResolution[] {
  if (notice.type !== 'guardrail.blocked' || !notice.resumable) return [];
  if (notice.messageKey === REDACTION_UNAVAILABLE_KEY) return ['acknowledged'];
  return GUARDRAIL_HOLD_RESOLUTIONS.filter((resolution) => resolution !== 'acknowledged' || !hasBlockFloor(notice));
}
