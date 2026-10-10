/**
 * TASK-1059 C-0 / OD-5 — the runtime medical judge works on CONTEXT only, before it is combined
 * with the prompt:
 *
 *   transcript / case notes / prior visits / attachment text / caller input
 *     → IContextMedicalJudgeService.judge → compose with the prompt → text /generate → LLM
 *
 * The composed message (system prompt, instruction, template) is never judged at runtime; prompts
 * are judged at build time only (governed-prompt registry, C-3). Typed, schema-validated fields
 * (age, dob, gender, vitals, lab values) are not narrative context and are never sent here (OD-8).
 *
 * FROZEN CONTRACT — lanes implement and consume it; changing it is an orchestrator decision.
 */

export const IContextMedicalJudgeService = Symbol('IContextMedicalJudgeService');

/** OD-8: narrative context only. */
export type ContextJudgeItemKind =
  | 'transcript'
  | 'case_note'
  | 'prior_visit'
  | 'attachment_text'
  | 'caller_input';

export interface ContextJudgeItem {
  /** Stable id of the piece (context item id, `encounter:<seq>`, `input:<field>`); echoed on the verdict. */
  id: string;
  kind: ContextJudgeItemKind;
  /** Plain text exactly as it will be composed into the prompt. */
  text: string;
}

export interface ContextJudgeRequest {
  tenantId: string;
  /** When present, OD-9 exclusion notices are raised on this consultation. */
  consultationId?: string;
  items: ContextJudgeItem[];
  requestId?: string;
}

export interface ContextJudgeVerdict {
  id: string;
  /** sha256 hex of `text` — the verdict cache key (with tenant and guardrail policy version). */
  digest: string;
  inScope: boolean;
  /** Guardrail `context_type` (`clinical` | `administrative` | `general` | …). */
  contextType: string;
  confidence: number;
  /** True when served from the verdict cache (no judge call was spent). */
  cached: boolean;
}

export interface ContextJudgeResult {
  /** One verdict per request item, same order. */
  verdicts: ContextJudgeVerdict[];
  /** Items to compose (in scope), request order preserved. */
  inScopeIds: string[];
  /** OD-9: items left out of the prompt; a WARNING notice was raised when `consultationId` was given. */
  excludedIds: string[];
  /**
   * OD-9: true only when at least one item was judged and NONE is in scope. The caller then refuses
   * the generation with `CONTENT_BLOCKED_NOT_MEDICAL`. An empty `items` list is never refused.
   */
  refused: boolean;
}

/**
 * Thrown when no verdict could be computed (guardrail unreachable / undetermined). Fail-CLOSED:
 * callers map it to the existing `GUARDRAIL_UNAVAILABLE` behaviour of their path (503 / degrade),
 * never to "in scope".
 */
export class ContextJudgeUnavailableError extends Error {
  readonly code = 'GUARDRAIL_UNAVAILABLE' as const;
  // `cause` is set by hand: this package's TS lib predates the ES2022 `Error(message, options)` overload.
  readonly cause?: unknown;
  constructor(message = 'context medical judge unavailable', options?: { cause?: unknown }) {
    super(message);
    this.name = 'ContextJudgeUnavailableError';
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

export interface IContextMedicalJudgeService {
  judge(request: ContextJudgeRequest): Promise<ContextJudgeResult>;
}
