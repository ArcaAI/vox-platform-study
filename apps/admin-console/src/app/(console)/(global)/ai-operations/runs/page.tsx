import type { Metadata } from 'next';
import { AiOperationsRunsScreen } from '@/features/ai-operations-runs/components/ai-operations-runs-screen';

export const metadata: Metadata = { title: 'AI Operations — Runs' };

/** TASK-512 screen 1 — trajectory runs, gate queue, cancel/signal (tier 10-19). */
export default function AiOperationsRunsPage() {
    return <AiOperationsRunsScreen />;
}
