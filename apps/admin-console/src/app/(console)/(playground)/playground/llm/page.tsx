import type { Metadata } from 'next';
import { PlaygroundLlmScreen } from '@/features/playground-llm/components/playground-llm-screen';

export const metadata: Metadata = { title: 'LLM Playground' };

/** Frame 54 — SMR prompt playground (tier 50-59, matrix row 38). */
export default function PlaygroundLlmPage() {
    return <PlaygroundLlmScreen />;
}
