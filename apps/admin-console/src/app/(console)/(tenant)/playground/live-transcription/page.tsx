import type { Metadata } from 'next';
import { LiveTranscriptionScreen } from '@/features/playground-live-transcription/components/live-transcription-screen';

export const metadata: Metadata = { title: 'Live Transcription' };

/** Playground tier — frame 51 (matrix row 35). */
export default function LiveTranscriptionPage() {
    return <LiveTranscriptionScreen />;
}
