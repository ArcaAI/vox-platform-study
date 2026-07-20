import type { Metadata } from 'next';
import { AgenticPolicyScreen } from '@/features/agentic-policy/components/agentic-policy-screen';

export const metadata: Metadata = { title: 'Agentic Policy' };

/** screen 3 — global-default agentic loop policy (tier 10-19, GLOBAL_ADMIN only). */
export default function AgenticPolicyPage() {
    return <AgenticPolicyScreen />;
}
