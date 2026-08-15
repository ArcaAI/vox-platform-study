import type { Metadata } from 'next';
import { AiTaskDefaultsPlatformScreen } from '@/features/ai-task-defaults/components/ai-task-defaults-platform-screen';

export const metadata: Metadata = { title: 'AI Task Defaults (Platform)' };

/** SYSTEM-tenant task-default rows (tier 10-19, SUPER_ADMIN only). */
export default function AiTaskDefaultsPage() {
  return <AiTaskDefaultsPlatformScreen />;
}
