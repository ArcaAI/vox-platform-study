import type { Metadata } from 'next';
import { PipelinePolicyScreen } from '@/features/pipeline-policy/components/pipeline-policy-screen';

export const metadata: Metadata = { title: 'Realtime Pipeline Policy' };

/** Frame 39 — Realtime pipeline policy cascade (tier 30-49, working tenant). */
export default function PipelinePolicyPage() {
    return <PipelinePolicyScreen />;
}
