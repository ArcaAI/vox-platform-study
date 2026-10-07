/**
 * TASK-1050 W2e — the hold-resolution rules (README §9.7.5, §9.8.1, OD-18, OD-24). Pure.
 *
 * Every hold is resumable: `item_excluded` and `item_edited` are always available. The
 * `acknowledged` override (proceed once at warn weight, recorded as `SAFETY_OVERRIDE`) is offered for
 * every tenant-set block EXCEPT a check whose PLATFORM FLOOR is `block` — today the catalogue-locked
 * medical validation (OD-9), whose notice carries `guardrail.blocked.not_medical`.
 */
import { ConflictException } from '@nestjs/common';
import { GUARDRAIL_ERROR_CODES, type HoldResolution } from '@arcaai/types';
import { GUARDRAIL_CHECK_DEFAULTS } from '../guardrail-availability/policy-catalogue';

/** Every 409 of the notice / hold surface, by code. A client branches on `code`, never on the message. */
export const GUARDRAIL_CONFLICT_CODES = Object.freeze({
  /** The consultation is in a guardrail hold and the request did not resolve it (approve). */
  hold: GUARDRAIL_ERROR_CODES.hold,
  /** The notice is already resolved (with another resolution than the one asked). */
  noticeResolved: 'GUARDRAIL_NOTICE_RESOLVED',
  /** A warning / unverified notice is acknowledged, never resumed. */
  noticeNotResumable: 'GUARDRAIL_NOTICE_NOT_RESUMABLE',
  /** `acknowledged` asked for a check whose platform floor is block (medical validation). */
  overrideNotAllowed: 'GUARDRAIL_OVERRIDE_NOT_ALLOWED',
  /** `item_edited` asked, but no flagged item has a version newer than the one that was blocked. */
  itemNotEdited: 'GUARDRAIL_ITEM_NOT_EDITED',
  /** An item resolution on the egress-redaction hold: it names no item — `acknowledged` (retry) only. */
  resolutionNotApplicable: 'GUARDRAIL_RESOLUTION_NOT_APPLICABLE',
} as const);
export type GuardrailConflictCode = (typeof GUARDRAIL_CONFLICT_CODES)[keyof typeof GUARDRAIL_CONFLICT_CODES];

export function guardrailConflict(code: GuardrailConflictCode, message: string, details: Record<string, unknown> = {}): ConflictException {
  return new ConflictException({ code, message, ...details });
}

const NOT_MEDICAL_KEY = 'guardrail.blocked.not_medical';
const REDACTION_UNAVAILABLE_KEY = 'guardrail.blocked.redaction_unavailable';

/**
 * The egress-redaction hold (EGRESS_REDACTION_UNAVAILABLE): a PRIVACY hold — the pseudonymiser was
 * down before a cloud call — not a safety verdict. Its `acknowledged` means RETRY, never an override.
 */
export function isRedactionHoldNotice(notice: { messageKey: string }): boolean {
  return notice.messageKey === REDACTION_UNAVAILABLE_KEY;
}

function checkIdsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) =>
    entry && typeof entry === 'object' && typeof (entry as { checkId?: unknown }).checkId === 'string' ? [(entry as { checkId: string }).checkId] : [],
  );
}

/** True when any check behind the notice has a platform floor of `block` (catalogue-locked at block). */
export function hasBlockFloor(notice: { messageKey: string; checks: unknown }): boolean {
  if (notice.messageKey === NOT_MEDICAL_KEY) return true;
  return checkIdsOf(notice.checks).some((checkId) => {
    const defaults = GUARDRAIL_CHECK_DEFAULTS[checkId];
    return !!defaults && defaults.locked && defaults.action === 'block';
  });
}

/** 409 `GUARDRAIL_OVERRIDE_NOT_ALLOWED` for an `acknowledged` override of a block-floor check. */
export function assertResolutionAllowed(notice: { id: string; messageKey: string; checks: unknown }, resolution: HoldResolution): void {
  if (isRedactionHoldNotice(notice)) {
    if (resolution === 'acknowledged') return;
    throw guardrailConflict(
      GUARDRAIL_CONFLICT_CODES.resolutionNotApplicable,
      'This hold names no item (patient details could not be protected before an external call): retry with `acknowledged`.',
      { noticeId: notice.id, allowedResolutions: ['acknowledged'] },
    );
  }
  if (resolution === 'acknowledged' && hasBlockFloor(notice)) {
    throw guardrailConflict(
      GUARDRAIL_CONFLICT_CODES.overrideNotAllowed,
      'This check is locked at block by the platform: exclude or edit the flagged content to continue.',
      { noticeId: notice.id, allowedResolutions: ['item_excluded', 'item_edited'] },
    );
  }
}

/**
 * The version each of the notice's items was screened at, from the evaluations that raised it
 * (`checks[].items`). An item two evaluations disagree on keeps the newest screened version.
 */
export function screenedVersionsFor(
  noticeId: string,
  itemIds: readonly string[],
  evaluations: ReadonlyArray<{ noticeIds: readonly string[]; checks: unknown }>,
): Map<string, number> {
  const wanted = new Set(itemIds);
  const versions = new Map<string, number>();
  for (const evaluation of evaluations) {
    if (!evaluation.noticeIds.includes(noticeId) || !Array.isArray(evaluation.checks)) continue;
    for (const check of evaluation.checks as Array<{ items?: Array<{ itemId?: unknown; itemVersion?: unknown }> }>) {
      for (const ref of check.items ?? []) {
        if (typeof ref.itemId !== 'string' || typeof ref.itemVersion !== 'number' || !wanted.has(ref.itemId)) continue;
        versions.set(ref.itemId, Math.max(versions.get(ref.itemId) ?? 0, ref.itemVersion));
      }
    }
  }
  return versions;
}
