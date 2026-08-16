import type { Metadata } from 'next';
import { RunTraceScreen } from '@/features/workflow-runs/components/run-trace-screen';

export const metadata: Metadata = { title: 'Run trace' };

/** Frame N.1 — Run trace (canvas overlay), tier 30-49. */
export default async function RunTracePage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <RunTraceScreen runId={runId} />;
}
