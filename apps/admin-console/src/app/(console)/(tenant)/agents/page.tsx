import type { Metadata } from 'next';
import { AgentsScreen } from '@/features/agents/components/agents-screen';

export const metadata: Metadata = { title: 'Agent Catalog' };

/** Frame 32 — Agent Catalog: DepartmentAgent + Agent Template administration (tier 30-49). */
export default function AgentsPage() {
    return <AgentsScreen />;
}
