import type { Metadata } from 'next';
import { ModelResidencyScreen } from '@/features/model-residency/components/model-residency-screen';

export const metadata: Metadata = { title: 'Model residency' };

/**
 * Model residency (tier 10-19, platform-admin only — D-11). Load/unload/pin/TTL
 * and policy control over stt, text, nlp and LM Studio, plus the shadow-mode
 * recommendation log (TASK-1005 §5.4).
 */
export default function ModelResidencyPage() {
  return <ModelResidencyScreen />;
}
