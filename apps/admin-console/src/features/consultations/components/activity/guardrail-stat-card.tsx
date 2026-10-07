import { formatNumber } from '@/shared/format';

/** `Aggregates.guardrail` (W2e, `ActivityGuardrailAggregatesResponse`): counts only. */
export interface GuardrailAggregates {
  evaluations: number;
  warn: number;
  block: number;
  unverified: number;
  openNotices: number;
}

/**
 * TASK-1050 W3b — the consultation's guardrail counts as a stat card beside the AI telemetry: every
 * evaluation, those decided warn / block / unverified, and the notices still open. Renders nothing when
 * the gateway did not record them.
 */
export function GuardrailStatCard({ aggregates }: { aggregates: GuardrailAggregates | undefined }) {
  if (!aggregates) return null;
  return (
    <div className="flex flex-col gap-0.5 rounded-md border px-3.5 py-2.5">
      <dt className="text-muted-foreground text-xs">Guardrail</dt>
      <dd className="flex flex-col">
        <span className="text-lg font-semibold tabular-nums">{`${formatNumber(aggregates.evaluations)} checked`}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {`${formatNumber(aggregates.warn)} warned · ${formatNumber(aggregates.block)} blocked · ${formatNumber(aggregates.unverified)} unverified`}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">{`${formatNumber(aggregates.openNotices)} open notices`}</span>
      </dd>
    </div>
  );
}
