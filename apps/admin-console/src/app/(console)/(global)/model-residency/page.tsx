import type { Metadata } from 'next';
import { ModelResidencyScreen } from '@/features/model-residency/components/model-residency-screen';

export const metadata: Metadata = { title: 'Model residency' };

/**
 * Model residency (tier 10-19, platform-admin only — D-11, reconfirmed
 * 2026-09-25). One table of every model each service can run, loaded or not,
 * grouped by service, with what needs attention, GPU memory and the
 * shadow-mode recommendations (TASK-1005 §13, TASK-1051 artboard 01).
 */
export default function ModelResidencyPage() {
  return <ModelResidencyScreen />;
}
