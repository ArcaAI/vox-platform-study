import { Badge } from '@arcaai/ui/components/shadcn/badge';
import type { ChangelogSeverity } from '../api/types';

/** Severity mapping — BREAKING is destructive, IMPORTANT default, INFO secondary. */
const VARIANT: Record<ChangelogSeverity, 'destructive' | 'default' | 'secondary'> = {
  BREAKING: 'destructive',
  IMPORTANT: 'default',
  INFO: 'secondary',
};

export function ChangelogSeverityBadge({ severity }: { severity: ChangelogSeverity }) {
  return <Badge variant={VARIANT[severity]}>{severity}</Badge>;
}
