import type { Metadata } from 'next';

import { resolveDocsAccess } from '@/server/api-docs';
import { ApiReferenceScreen } from '@/features/developer-docs/components/api-reference-screen';

export const metadata: Metadata = {
  title: 'API reference',
};

/**
 * The OpenAPI reference. Which projections the caller may switch between is
 * decided server-side and passed down as a boolean — the client never asks for
 * a plane it was not offered, and `/api/docs/spec/admin` refuses it anyway.
 */
export default async function ApiReferencePage() {
  const access = await resolveDocsAccess();
  return <ApiReferenceScreen canReadAdminPlane={access.canReadAdminPlane} />;
}
