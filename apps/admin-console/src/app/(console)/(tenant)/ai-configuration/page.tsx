import type { Metadata } from 'next';
import { TenantAiConfigurationScreen } from '@/features/ai-task-defaults/components/tenant-ai-configuration-screen';

export const metadata: Metadata = { title: 'AI Configuration' };

/**
 * Tenant AI configuration (tier 30-49, working tenant): read-only
 * effective models for all 9 task keys + BYO cloud provider credentials.
 * Successor to the dead-end `/ai-model-defaults` screen, which now
 * redirects here.
 */
export default function AiConfigurationPage() {
  return <TenantAiConfigurationScreen />;
}
