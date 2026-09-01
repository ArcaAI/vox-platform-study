import type { Metadata } from 'next';
import { AiPlatformScreen } from '@/features/ai-platform/components/ai-platform-screen';

export const metadata: Metadata = { title: 'AI Platform' };

/**
 * The unified AI provider console (TASK-845).
 *
 * TIER 20-29 (shared audience): it renders cross-tenant for a super admin and
 * tenant-scoped for a tenant admin, which is exactly what the `(shared)` group
 * expresses. The screen's own tier control chooses between the SYSTEM
 * (platform-default) tier and the working tenant — tenancy is a selector here,
 * not a route, because those are the two tiers of one cascade.
 *
 * Surfaces the backend restricts further stay restricted: routing-policy writes
 * are SUPER_ADMIN-only and answer 403, which the Providers tab renders as
 * "managed by the platform" rather than as a failure.
 */
export default function AiPlatformPage() {
  return <AiPlatformScreen />;
}
