import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getSession, isElevated } from '@/server/session';

/**
 * Tier 10–19 guard (rule 13): global-only screens 404 for non-elevated
 * sessions — never 403 — matching the gateway's existence-hiding posture.
 */
export default async function GlobalTierLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!isElevated(session?.user)) {
    notFound();
  }
  return children;
}
