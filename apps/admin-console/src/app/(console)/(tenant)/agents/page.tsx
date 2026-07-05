import type { Metadata } from 'next';
import { AgentsScreen } from '@/features/agents/components/agents-screen';

export const metadata: Metadata = { title: 'Agents & Prompt Templates' };

/** Frame 32 — Agents & prompt-template administration (tier 30-49). */
export default function AgentsPage() {
    return <AgentsScreen />;
}
