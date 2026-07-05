import type { Metadata } from 'next';
import { AiModelsScreen } from '@/features/ai-models/components/ai-models-screen';

export const metadata: Metadata = {
    title: 'AI Model Registry',
};

/** Frame 15 — AI Model Registry (tier 10-19, GLOBAL_ADMIN only). */
export default function AiModelsPage() {
    return <AiModelsScreen />;
}
