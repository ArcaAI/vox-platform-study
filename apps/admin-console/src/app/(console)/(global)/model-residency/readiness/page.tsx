import type { Metadata } from 'next';
import { ReadinessScreen } from '@/features/model-residency/components/readiness-screen';

export const metadata: Metadata = { title: 'Enforce readiness' };

/** Enforce readiness (tier 10-19, platform-admin only): the checks that gate `residency.enforce`, plus what the shadow controller would have done. */
export default function ModelResidencyReadinessPage() {
  return <ReadinessScreen />;
}
