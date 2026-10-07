import { IconShieldExclamation } from '@tabler/icons-react';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';

const STATUS_META: Record<string, { label: string; role: StatusColorRole }> = {
  warned: { label: 'Guardrail warning', role: 'warning' },
  blocked: { label: 'Guardrail blocked', role: 'destructive' },
  withheld: { label: 'Withheld by guardrail', role: 'destructive' },
};

/**
 * TASK-1050 W3b — an item's guardrail marker (`ContextItem.guardrailStatus`, README §9.7.4) and/or its
 * warn / block counts. Text always rides with the colour (rule 11 §10). A clean item renders nothing.
 */
export function GuardrailItemBadge({ status, warn = 0, block = 0 }: { status?: string | null; warn?: number; block?: number }) {
  const meta = status ? STATUS_META[status.toLowerCase()] : undefined;
  const parts: string[] = [];
  if (block > 0) parts.push(`${block} blocked`);
  if (warn > 0) parts.push(`${warn} ${warn === 1 ? 'warning' : 'warnings'}`);
  if (!meta && parts.length === 0) return null;
  const label = meta ? (parts.length > 0 ? `${meta.label} · ${parts.join(', ')}` : meta.label) : `Guardrail: ${parts.join(', ')}`;
  const role: StatusColorRole = meta?.role ?? (block > 0 ? 'destructive' : 'warning');
  return <StatusBadge label={label} colorRole={role} icon={<IconShieldExclamation aria-hidden />} />;
}
