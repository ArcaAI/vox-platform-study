'use client';

import type { ReactNode } from 'react';
import { can } from '@/shared/auth/ability';
import { usePermissions } from '@/shared/auth/hooks';

interface RequirePermissionProps {
  action: string;
  subject: string;
  /** Rendered while permissions load or when the ability denies. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Client-side visibility gate (UX only — the gateway enforces authorization).
 * Renders nothing by default when denied, matching the 404-over-403 posture.
 */
export function RequirePermission({ action, subject, fallback = null, children }: RequirePermissionProps) {
  const { data: rules, isPending } = usePermissions();
  if (isPending || !can(rules, action, subject)) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}
