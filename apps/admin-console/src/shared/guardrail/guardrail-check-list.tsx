import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import type { GuardrailNotice } from './notice';
import { guardrailCategoryLabel, guardrailCheckLabel } from './labels';

const SEVERITY_ROLE: Record<string, StatusColorRole> = { low: 'neutral', medium: 'warning', high: 'destructive' };

/** The checks behind a notice: name, category and severity (text, never colour alone). No content. */
export function GuardrailCheckList({ checks, className }: { checks: GuardrailNotice['checks']; className?: string }) {
  if (checks.length === 0) return null;
  return (
    <ul className={className ? `flex flex-col gap-1 ${className}` : 'flex flex-col gap-1'}>
      {checks.map((check, index) => (
        <li key={`${check.checkId}-${index}`} className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="font-medium">{guardrailCheckLabel(check.checkId)}</span>
          {check.category ? <span className="text-muted-foreground">{`· ${guardrailCategoryLabel(check.category)}`}</span> : null}
          <StatusBadge label={`${check.severity} severity`} colorRole={SEVERITY_ROLE[check.severity] ?? 'neutral'} />
        </li>
      ))}
    </ul>
  );
}
