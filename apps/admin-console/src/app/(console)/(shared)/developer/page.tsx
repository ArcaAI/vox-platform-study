import type { Metadata } from 'next';

import { resolveDocsAccess } from '@/server/api-docs';
import { DeveloperOverviewScreen } from '@/features/developer-docs/components/developer-overview-screen';

export const metadata: Metadata = {
  title: 'Developer',
};

/** Tier 20–29 — the developer portal's landing screen (TASK-783). */
export default async function DeveloperPage() {
  const access = await resolveDocsAccess();
  return <DeveloperOverviewScreen canReadAdminPlane={access.canReadAdminPlane} />;
}
