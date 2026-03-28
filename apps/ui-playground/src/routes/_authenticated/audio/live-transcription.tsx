import AudioPage from '@/features/audio';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/audio/live-transcription')({
  component: AudioPage,
});
