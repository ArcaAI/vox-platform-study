'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import type { ApiKey, ApiKeyStatus } from '../api/types';

const KEY_STATUS_META: Record<ApiKeyStatus, { label: string; role: StatusColorRole }> = {
  ACTIVE: { label: 'Active', role: 'success' },
  INACTIVE: { label: 'Inactive', role: 'neutral' },
  EXPIRED: { label: 'Expired', role: 'neutral' },
  REVOKED: { label: 'Revoked', role: 'destructive' },
};

const EXPIRING_WINDOW_MS = 30 * 86_400_000;

/** Frame 23 matrix: an ACTIVE key expiring within 30 days gets a warning badge. */
export function isExpiringSoon(apiKey: ApiKey, now: Date = new Date()): boolean {
  if (apiKey.keyStatus !== 'ACTIVE' || !apiKey.expiresAt) return false;
  const remaining = new Date(apiKey.expiresAt).getTime() - now.getTime();
  return remaining > 0 && remaining <= EXPIRING_WINDOW_MS;
}

/** keyStatus rendering per frame 23 — dot + label, never color alone (rule 11). */
export function KeyStatusBadge({ apiKey }: { apiKey: ApiKey }) {
  const meta = isExpiringSoon(apiKey)
    ? { label: 'Expiring', role: 'warning' as StatusColorRole }
    : (KEY_STATUS_META[apiKey.keyStatus] ?? { label: apiKey.keyStatus, role: 'neutral' as StatusColorRole });
  return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />;
}
