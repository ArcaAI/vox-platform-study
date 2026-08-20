import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { resolveDocsAccess } from '@/server/api-docs';

/**
 * TASK-783 — the developer portal is gated on `read:ApiDocumentation`
 * (owner decision D-1), checked once here for every screen beneath it.
 *
 * `notFound()` rather than a 403 page, matching the tier-10–19 guard and the
 * gateway's existence-hiding posture: a caller without the ability is not told
 * that a developer portal exists. The spec route handler under
 * `/api/docs/spec/*` repeats the check independently — this layout controls
 * the SCREENS, that one controls the BYTES, and neither may rely on the other.
 */
export default async function DeveloperDocsLayout({ children }: { children: ReactNode }) {
  const access = await resolveDocsAccess();
  if (!access.canRead) {
    notFound();
  }
  return children;
}
