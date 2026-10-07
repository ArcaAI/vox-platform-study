/**
 * TASK-1050 W3b — the guardrail outcome of a DNA writing-style generation (README §9.6: "the same block
 * and warn handling"). Two moments can carry one:
 *
 * - the QUEUE call (`POST dna-writing-styles/generate`) — a synchronous 422 block / 503 redaction hold;
 * - the JOB, which runs the analyst agent through TEXT — a `failed` job whose `error` is a guardrail code
 *   (or that carries a notice), or a `completed` job whose result lists warn notices.
 *
 * The job wire is the DNA processor's; where it puts the notices is not frozen, so both the job and its
 * `result` are read defensively. Pure.
 */
import { classifyGuardrailError } from '@/shared/guardrail/guardrail-error';
import { isWarningNotice, mergeGuardrailNotices, toGuardrailNotice, toGuardrailNotices, type GuardrailNotice } from '@/shared/guardrail/notice';
import type { DnaJobStatus } from '../api';

export interface DnaGuardrailState {
  block: { notice: GuardrailNotice | null; code: string | null; redaction?: boolean } | null;
  warnings: GuardrailNotice[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function dnaGuardrailFromError(error: unknown): DnaGuardrailState | null {
  const outcome = classifyGuardrailError(error);
  if (!outcome) return null;
  return { block: { notice: outcome.notice, code: outcome.code, ...(outcome.kind === 'redaction_unavailable' ? { redaction: true } : {}) }, warnings: [] };
}

export function dnaGuardrailFromJob(job: DnaJobStatus & Record<string, unknown>): DnaGuardrailState | null {
  const result = isRecord(job.result) ? job.result : {};
  if (job.status === 'failed') {
    const notice = toGuardrailNotice(job.guardrailNotice ?? result.guardrailNotice);
    const code = typeof job.error === 'string' && /^(CONTENT_BLOCKED|EGRESS_REDACTION_UNAVAILABLE)/.test(job.error) ? job.error : null;
    if (!notice && !code) return null;
    return { block: { notice, code, ...(code === 'EGRESS_REDACTION_UNAVAILABLE' ? { redaction: true } : {}) }, warnings: [] };
  }
  if (job.status === 'completed') {
    const warnings = [...mergeGuardrailNotices(toGuardrailNotices(job), toGuardrailNotices(result))].filter(isWarningNotice);
    return warnings.length > 0 ? { block: null, warnings } : null;
  }
  return null;
}
