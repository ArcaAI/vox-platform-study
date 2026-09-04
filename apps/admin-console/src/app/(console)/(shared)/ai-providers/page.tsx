import type { Metadata } from 'next';
import { AiProvidersScreen } from '@/features/ai-providers/components/ai-providers-screen';

export const metadata: Metadata = { title: 'AI Providers' };

/**
 * The one AI provider screen (TASK-862).
 *
 * TIER 20-29 (shared audience): it renders cross-tenant for a super admin and
 * tenant-scoped for a tenant admin, which is exactly what the `(shared)` group
 * expresses. The screen's own tier control chooses between the SYSTEM
 * (platform-default) tier and the working tenant — tenancy is a selector here,
 * not a route, because those are the two tiers of one cascade.
 */
export default function AiProvidersPage() {
  return <AiProvidersScreen />;
}
