import type { GuardrailEvaluationRepository, GuardrailNoticeRepository } from '@arcaai/domains';

/** The guardrail counts the consultation activity aggregates carry (TASK-1050 §9.6). Counts only. */
export interface GuardrailAggregates {
  evaluations: number;
  warn: number;
  block: number;
  unverified: number;
  openNotices: number;
}

/**
 * One consultation's guardrail counts: every evaluation, those decided warn / block / unverified,
 * and the notices still OPEN. The Prisma enum values are spelled out so this stays a pure read.
 */
export async function countGuardrailAggregates(
  evaluations: Pick<GuardrailEvaluationRepository, 'count'>,
  notices: Pick<GuardrailNoticeRepository, 'count'>,
  tenantId: string,
  consultationId: string,
): Promise<GuardrailAggregates> {
  const base = { tenantId, consultationId };
  const [all, warn, block, unverified, openNotices] = await Promise.all([
    evaluations.count({ where: base as never }),
    evaluations.count({ where: { ...base, decision: 'WARN' } as never }),
    evaluations.count({ where: { ...base, decision: 'BLOCK' } as never }),
    evaluations.count({ where: { ...base, decision: 'UNVERIFIED' } as never }),
    notices.count({ where: { ...base, status: 'OPEN' } as never }),
  ]);
  return { evaluations: all, warn, block, unverified, openNotices };
}
