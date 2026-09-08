import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { effectiveRoles, getSession, isElevated } from '@/server/session';

/**
 * Tier 10–19 guard (rule 13): global-only screens 404 for non-elevated
 * sessions — never 403 — matching the gateway's existence-hiding posture.
 * Judged on the EFFECTIVE identity (the impersonated target while
 * impersonating), so the guard agrees with the nav and the BFF (TASK-932).
 */
export default async function GlobalTierLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!isElevated({ roles: [...effectiveRoles(session)] })) {
    notFound();
  }
  return children;
}
