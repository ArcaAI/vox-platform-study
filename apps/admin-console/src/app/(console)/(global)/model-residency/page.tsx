import type { Metadata } from 'next';
import { ModelResidencyScreen } from '@/features/model-residency/components/model-residency-screen';

export const metadata: Metadata = { title: 'Model residency' };

/**
 * Model residency (tier 10-19, platform-admin only — D-11, reconfirmed
 * 2026-09-25). Catalogue-first, grouped by service: every self-hosted model
 * for stt, stt-worker, LM Studio and nlp, loaded or not, with who uses it,
 * its keep policy, and load/unload/reload control (TASK-1005 §13).
 */
export default function ModelResidencyPage() {
  return <ModelResidencyScreen />;
}
