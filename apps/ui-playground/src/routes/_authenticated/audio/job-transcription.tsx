import BatchTranscriptionPage from '@/features/audio/batch';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/audio/job-transcription')({
  component: BatchTranscriptionPage,
});
