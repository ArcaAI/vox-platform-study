import type { Metadata } from 'next';
import { PromptStudioScreen } from '@/features/prompt-studio/components/prompt-studio-screen';

export const metadata: Metadata = { title: 'Prompt Studio' };

/** TASK-512 screen 4 — prompt governance / clinical approval (tier 10-19). */
export default function PromptStudioPage() {
    return <PromptStudioScreen />;
}
