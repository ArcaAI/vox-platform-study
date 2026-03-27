import { cn } from '@/lib/utils';
import { Badge } from '@arcaai/ui/badge';

const STATUS_STYLES: Record<string, string> = {
  ENABLED: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  ACTIVE: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  DISABLED: 'bg-red-500/15 text-red-700 dark:text-red-400',
  DELETED: 'bg-red-500/15 text-red-700 dark:text-red-400',
  REVOKED: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  PENDING: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  SUSPENDED: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  ARCHIVED: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
};

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <Badge variant="outline" className={cn('text-xs', STATUS_STYLES[status.toUpperCase()] ?? '', className)}>
      {status}
    </Badge>
  );
}
