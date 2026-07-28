import type { Metadata } from 'next';
import { TranscriptionJobsScreen } from '@/features/transcription-jobs/components/transcription-jobs-screen';

export const metadata: Metadata = { title: 'Transcription Jobs' };

/** Frame 35 — Transcription jobs ops surface (tier 30–49). */
export default function TranscriptionJobsPage() {
  return <TranscriptionJobsScreen />;
}
