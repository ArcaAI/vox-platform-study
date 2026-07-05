import type { Metadata } from 'next';
import { HarnessWorkflowsScreen } from '@/features/harness-ops/components/harness-workflows-screen';

export const metadata: Metadata = { title: 'Harness Workflows' };

/** Frame 38 — Harness workflows (tier 30-49). */
export default function HarnessWorkflowsPage() {
    return <HarnessWorkflowsScreen />;
}
