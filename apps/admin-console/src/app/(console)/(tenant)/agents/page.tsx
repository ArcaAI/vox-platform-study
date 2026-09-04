import type { Metadata } from 'next';
import { AgentsScreen } from '@/features/agents/components/agents-screen';

export const metadata: Metadata = { title: 'Agents' };

/**
 * Agents (tier 30-49, `manage:Agent`) — TASK-863: the first-class, task-typed,
 * publishable Agent. One task (speech-to-text · text generation · text-to-speech),
 * one registry model (+ fallbacks), task-typed instruction / parameters / I-O
 * schemas, versioned and published like a workflow definition, invokable on its
 * own and referenced by the Studio's `core.agent` node.
 */
export default function AgentsPage() {
  return <AgentsScreen />;
}
