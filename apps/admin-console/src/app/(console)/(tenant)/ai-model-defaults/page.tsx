import type { Metadata } from 'next';
import { AiModelDefaultsTenantScreen } from '@/features/ai-task-defaults/components/ai-model-defaults-tenant-screen';

export const metadata: Metadata = { title: 'AI Model Defaults' };

/** TASK-506 Phase 6 — tenant NLP model defaults (tier 30-49, working tenant). */
export default function AiModelDefaultsPage() {
  return <AiModelDefaultsTenantScreen />;
}
