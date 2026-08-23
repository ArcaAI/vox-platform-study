import type { Metadata } from 'next';
import { RuntimeProfilesScreen } from '@/features/ai-runtime-profiles/components/runtime-profiles-screen';

export const metadata: Metadata = { title: 'AI Runtime Profiles' };

/**
 * Platform AI runtime profiles (tier 10-19, SUPER_ADMIN only) — the
 * hyperparameter / capacity / timing plane that had five gateway routes and no
 * screen until TASK-799 Phase 4.
 */
export default function AiRuntimeProfilesPage() {
  return <RuntimeProfilesScreen />;
}
