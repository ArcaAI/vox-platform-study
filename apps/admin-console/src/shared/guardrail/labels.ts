/**
 * TASK-1050 W3b — display labels for the guardrail vocabulary (`@arcaai/types` guardrail-vocabulary).
 * Machine values stay on the wire; these are the words a clinician or an admin reads.
 */
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES } from '@arcaai/types';
import type { GuardrailActionTaken, GuardrailCheckVerdict, GuardrailDecision, GuardrailDirection, HoldResolution } from '@arcaai/types';
import type { StatusColorRole } from '@arcaai/ui/components/shared/status-badge';

const CHECK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  jailbreak_detection: 'Jailbreak detection',
  prompt_safety: 'Prompt safety',
  prompt_toxicity: 'Prompt toxicity',
  response_safety: 'Response safety',
  response_toxicity: 'Response toxicity',
  response_refusal: 'Response refusal',
  pii_leak: 'Personal data leak',
  containment_echo: 'Containment echo',
  medical_validation: 'Medical scope',
  injection_judge: 'Prompt injection (judge)',
  unsafe_content_judge: 'Unsafe content (judge)',
  clinical_safety_judge: 'Clinical safety (judge)',
  leakage_judge: 'Leakage (judge)',
});

/** A check's display name; an unknown id (a newer server) shows as-is. */
export function guardrailCheckLabel(checkId: string): string {
  return CHECK_LABELS[checkId] ?? checkId;
}

/** A category id (`system_prompt`) as words (`system prompt`). */
export function guardrailCategoryLabel(category: string): string {
  return category.replace(/[_-]+/g, ' ');
}

export function guardrailDirectionLabel(direction: GuardrailDirection | string): string {
  return direction === 'outbound' ? 'Outbound (generated content)' : 'Inbound (input to the model)';
}

export function guardrailDirectionShortLabel(direction: GuardrailDirection | string): string {
  return direction === 'outbound' ? 'Outbound' : 'Inbound';
}

export const HOLD_RESOLUTION_LABELS: Readonly<Record<HoldResolution, string>> = Object.freeze({
  item_excluded: 'Exclude the flagged content and continue',
  item_edited: 'I edited the flagged content, continue',
  acknowledged: 'Override and continue once',
});

/** The egress-redaction hold's single resolution reads as a retry, not an override. */
export const REDACTION_RETRY_LABEL = 'Retry now';

const ACTION_TAKEN: Readonly<Record<string, { label: string; role: StatusColorRole }>> = Object.freeze({
  none: { label: 'Passed', role: 'success' },
  ignore: { label: 'Recorded', role: 'neutral' },
  warn: { label: 'Warned', role: 'warning' },
  block: { label: 'Blocked', role: 'destructive' },
  unverified: { label: 'Unverified', role: 'info' },
});

export function guardrailActionTakenMeta(actionTaken: GuardrailActionTaken | string): { label: string; role: StatusColorRole } {
  return ACTION_TAKEN[actionTaken.toLowerCase()] ?? { label: actionTaken, role: 'neutral' };
}

const DECISION: Readonly<Record<string, { label: string; role: StatusColorRole }>> = Object.freeze({
  allow: { label: 'Allowed', role: 'success' },
  warn: { label: 'Warned', role: 'warning' },
  block: { label: 'Blocked', role: 'destructive' },
  unverified: { label: 'Unverified', role: 'info' },
});

export function guardrailDecisionMeta(decision: GuardrailDecision | string): { label: string; role: StatusColorRole } {
  return DECISION[decision.toLowerCase()] ?? { label: decision, role: 'neutral' };
}

const VERDICT: Readonly<Record<string, string>> = Object.freeze({
  pass: 'Pass',
  flag: 'Flagged',
  undetermined: 'Could not run',
  skipped: 'Skipped',
});

export function guardrailVerdictLabel(verdict: GuardrailCheckVerdict | string): string {
  return VERDICT[verdict] ?? verdict;
}

/** The run-trace action (`ALLOW | REDACT | BLOCK | WARN | IGNORE`, run protocol v2). */
const TRACE_ACTION: Readonly<Record<string, { label: string; role: StatusColorRole }>> = Object.freeze({
  ALLOW: { label: 'Allowed', role: 'success' },
  REDACT: { label: 'Redacted', role: 'info' },
  BLOCK: { label: 'Blocked', role: 'destructive' },
  WARN: { label: 'Warned', role: 'warning' },
  IGNORE: { label: 'Recorded', role: 'neutral' },
});

export function guardrailTraceActionMeta(action: string): { label: string; role: StatusColorRole } {
  return TRACE_ACTION[action] ?? { label: action, role: 'neutral' };
}

/** Copy for a block that arrived without a notice (an older gateway relays only the legacy code). */
export function legacyBlockCopy(code: string | null | undefined): string {
  switch (code) {
    case 'CONTENT_BLOCKED_NOT_MEDICAL':
      return 'The content was not classified as clinical, so it was not processed.';
    case 'CONTENT_BLOCKED':
      return 'A safety check stopped this request.';
    case 'EGRESS_REDACTION_UNAVAILABLE':
      return GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.redaction_unavailable'];
    default:
      return 'A safety check stopped this request.';
  }
}
