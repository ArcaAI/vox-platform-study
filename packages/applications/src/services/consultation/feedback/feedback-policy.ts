export const FEEDBACK_RATINGS = ['up', 'down', 'cleared'] as const;
export type FeedbackRatingValue = (typeof FEEDBACK_RATINGS)[number];

export const FEEDBACK_TARGET_KINDS = ['NOTE', 'SECTION', 'SEGMENT', 'ENTITY', 'TRANSCRIPT', 'RECAP'] as const;
export type FeedbackTargetKindValue = (typeof FEEDBACK_TARGET_KINDS)[number];

/** The target kinds whose text a clinician can replace; anything else can only be rated or commented on. */
export const FEEDBACK_CORRECTABLE_KINDS: readonly FeedbackTargetKindValue[] = ['NOTE', 'SECTION', 'SEGMENT', 'TRANSCRIPT'];

export const FEEDBACK_ERROR_CODES = {
  EMPTY: 'FEEDBACK_EMPTY',
  TARGET_REQUIRED: 'FEEDBACK_TARGET_REQUIRED',
  REASON_UNKNOWN: 'FEEDBACK_REASON_UNKNOWN',
  REASON_NOT_ALLOWED: 'FEEDBACK_REASON_NOT_ALLOWED',
  ATTACHMENT_INVALID: 'FEEDBACK_ATTACHMENT_INVALID',
  CORRECTION_UNSUPPORTED: 'FEEDBACK_CORRECTION_UNSUPPORTED',
  COMMENT_TOO_LONG: 'FEEDBACK_COMMENT_TOO_LONG',
} as const;
export type FeedbackErrorCode = (typeof FEEDBACK_ERROR_CODES)[keyof typeof FEEDBACK_ERROR_CODES];

/** A refusal the policy decided; the service maps it onto the HTTP exception. */
export class FeedbackPolicyError extends Error {
  constructor(
    readonly code: FeedbackErrorCode,
    readonly httpStatus: 400 | 413,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'FeedbackPolicyError';
  }
}

export interface FeedbackTargetRef {
  readonly kind: FeedbackTargetKindValue;
  readonly contextItemId: string;
  readonly versionNumber?: number | null;
  readonly sectionKey?: string | null;
  readonly documentKey?: string | null;
  readonly entityRef?: string | null;
}

/** `kind|item|ver|section|entity` — the identity a rating is "latest" within. Absent parts are empty. */
export function targetKey(target: FeedbackTargetRef): string {
  return [target.kind, target.contextItemId, target.versionNumber ?? '', target.sectionKey ?? '', target.entityRef ?? ''].join('|');
}

export interface FeedbackReason {
  readonly code: string;
  readonly label: string;
  /** Target kinds the reason is offered for; absent = all. */
  readonly appliesTo?: readonly FeedbackTargetKindValue[];
}

/** The reasons offered for a target kind (a consultation-level comment, with no target, is offered the unrestricted ones). */
export function reasonsFor(list: readonly FeedbackReason[], kind?: FeedbackTargetKindValue): FeedbackReason[] {
  return list.filter((r) => !r.appliesTo || (kind !== undefined && r.appliesTo.includes(kind)));
}

const REASON_CODE = /^[a-z][a-z0-9_]{1,47}$/;

/** The `consultation.feedback.reasonCodes` value check: 1–32 unique entries, code pattern, label 1–80. */
export function validateReasonList(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return 'Must be a list of 1 to 32 reasons.';
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return 'Each reason must be an object with a code and a label.';
    const { code, label, appliesTo } = entry as Record<string, unknown>;
    if (typeof code !== 'string' || !REASON_CODE.test(code)) return `Reason code '${String(code)}' must match ${REASON_CODE.source}.`;
    if (seen.has(code)) return `Reason code '${code}' is listed twice.`;
    seen.add(code);
    if (typeof label !== 'string' || label.length < 1 || label.length > 80) return `Reason '${code}' needs a label of 1 to 80 characters.`;
    if (appliesTo !== undefined) {
      if (!Array.isArray(appliesTo) || appliesTo.some((k) => !(FEEDBACK_TARGET_KINDS as readonly unknown[]).includes(k))) {
        return `Reason '${code}' has an invalid appliesTo.`;
      }
    }
  }
  return undefined;
}

export interface FeedbackShapeInput {
  readonly target?: FeedbackTargetRef | null;
  readonly rating?: FeedbackRatingValue | null;
  readonly reasonCodes?: readonly string[] | null;
  readonly comment?: string | null;
  readonly attachmentIds?: readonly string[] | null;
  readonly correction?: { readonly content: string } | null;
}

export interface FeedbackShapeLimits {
  /** The effective reason list (tenant value, else the platform one). */
  readonly reasons: readonly FeedbackReason[];
  /** `consultation.feedback.commentMaxChars`. */
  readonly commentMaxChars: number;
  /** `consultation.feedback.maxMediaPerFeedback`. */
  readonly maxMedia: number;
}

/** The structural rules of one feedback entry; throws a {@link FeedbackPolicyError}, never returns a verdict. */
export function assertFeedbackShape(input: FeedbackShapeInput, limits: FeedbackShapeLimits): void {
  const comment = input.comment?.trim() ?? '';
  const attachmentIds = input.attachmentIds ?? [];
  const reasonCodes = input.reasonCodes ?? [];
  const hasRating = input.rating != null;
  const hasCorrection = input.correction != null;

  if (!hasRating && comment.length === 0 && attachmentIds.length === 0 && !hasCorrection) {
    throw new FeedbackPolicyError(FEEDBACK_ERROR_CODES.EMPTY, 400, 'Feedback needs a rating, a comment, an attachment or a correction.');
  }
  if (hasRating && !input.target) {
    throw new FeedbackPolicyError(FEEDBACK_ERROR_CODES.TARGET_REQUIRED, 400, 'A rating needs a target.');
  }
  if (hasCorrection) {
    if (!input.target) {
      throw new FeedbackPolicyError(FEEDBACK_ERROR_CODES.TARGET_REQUIRED, 400, 'A correction needs a target.');
    }
    if (!FEEDBACK_CORRECTABLE_KINDS.includes(input.target.kind)) {
      throw new FeedbackPolicyError(FEEDBACK_ERROR_CODES.CORRECTION_UNSUPPORTED, 400, `A '${input.target.kind}' cannot be corrected.`, {
        correctableKinds: [...FEEDBACK_CORRECTABLE_KINDS],
      });
    }
  }
  if (comment.length > limits.commentMaxChars) {
    throw new FeedbackPolicyError(FEEDBACK_ERROR_CODES.COMMENT_TOO_LONG, 413, `The comment exceeds ${limits.commentMaxChars} characters.`, {
      maxChars: limits.commentMaxChars,
    });
  }
  if (reasonCodes.length > 0) {
    if (input.rating !== 'down') {
      throw new FeedbackPolicyError(FEEDBACK_ERROR_CODES.REASON_NOT_ALLOWED, 400, 'Reasons go with a down rating only.');
    }
    const allowed = reasonsFor(limits.reasons, input.target?.kind).map((r) => r.code);
    const unknown = reasonCodes.filter((code) => !allowed.includes(code));
    if (unknown.length > 0) {
      throw new FeedbackPolicyError(FEEDBACK_ERROR_CODES.REASON_UNKNOWN, 400, `Unknown reason: ${unknown.join(', ')}.`, { allowed, unknown });
    }
  }
  if (attachmentIds.length > limits.maxMedia || new Set(attachmentIds).size !== attachmentIds.length) {
    throw new FeedbackPolicyError(
      FEEDBACK_ERROR_CODES.ATTACHMENT_INVALID,
      400,
      `At most ${limits.maxMedia} distinct attachments may back one feedback entry.`,
      { maxMedia: limits.maxMedia },
    );
  }
}
