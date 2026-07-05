import type { Metadata } from 'next';
import { AudioPipelinesScreen } from '@/features/audio-pipelines/components/audio-pipelines-screen';

export const metadata: Metadata = { title: 'Audio Pipelines' };

/** Frame 34 — Audio pipelines administration (tier 30–49). */
export default function AudioPipelinesPage() {
    return <AudioPipelinesScreen />;
}
