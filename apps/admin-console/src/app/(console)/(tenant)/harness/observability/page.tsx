import type { Metadata } from 'next';
import { HarnessObservabilityScreen } from '@/features/harness-ops/components/harness-observability-screen';

export const metadata: Metadata = { title: 'Harness Observability' };

/** Frame 37 — Harness observability (tier 30-49). */
export default function HarnessObservabilityPage() {
  return <HarnessObservabilityScreen />;
}
