import type { Metadata } from 'next';
import { AiOperationsMetricsScreen } from '@/features/ai-operations-metrics/components/ai-operations-metrics-screen';

export const metadata: Metadata = { title: 'AI Operations — Metrics' };

/** screen 2 — derived generation metrics (TTFT/tok-s/stop-reason/regen), tier 10-19. */
export default function AiOperationsMetricsPage() {
  return <AiOperationsMetricsScreen />;
}
