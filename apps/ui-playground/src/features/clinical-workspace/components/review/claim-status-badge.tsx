import { cn } from '@/lib/utils';
import { Badge } from '@arcaai/ui/badge';
import type { ClaimStatus } from '@arcaai/vox';
import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';

// TASK-330 Phase 1 (Lane J) — consistent status colour mapping for the
// linked-evidence review UI. `flagged` (a sensor contradicted the claim) is the
// most severe, `unverified` (no provenance) is cautionary, `verified` is safe.
const STATUS_CONFIG: Record<ClaimStatus, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  verified: {
    label: 'Verified',
    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    Icon: CheckCircle2,
  },
  unverified: {
    label: 'Unverified',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    Icon: AlertCircle,
  },
  flagged: {
    label: 'Flagged',
    className: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400',
    Icon: AlertTriangle,
  },
};

interface ClaimStatusBadgeProps {
  status: ClaimStatus;
  className?: string;
}

export function ClaimStatusBadge({ status, className }: ClaimStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  const Icon = config.Icon;
  return (
    <Badge variant="outline" data-status={status} className={cn('gap-1 text-[10px] font-medium', config.className, className)}>
      <Icon className="size-3" />
      {config.label}
    </Badge>
  );
}
