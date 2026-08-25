'use client';

import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { grantLifecycle, type ConsentGrant, type ConsentGrantLifecycle } from '../api';

const LIFECYCLE_META: Record<ConsentGrantLifecycle, { label: string; role: StatusColorRole }> = {
  ACTIVE: { label: 'Active', role: 'success' },
  REVOKED: { label: 'Withdrawn', role: 'destructive' },
  EXPIRED: { label: 'Expired', role: 'warning' },
};

/**
 * Lifecycle of a grant as the ABAC gate would see it right now. Never colour
 * alone — the label carries the meaning (rule 11 §11).
 */
export function ConsentStatusBadge({ grant }: { grant: ConsentGrant }) {
  const meta = LIFECYCLE_META[grantLifecycle(grant)];
  return <StatusBadge label={meta.label} colorRole={meta.role} />;
}
