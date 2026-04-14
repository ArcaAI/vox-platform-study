import VoiceProfilePage from '@/features/voice-profile';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/voice-profile')({
  component: VoiceProfilePage,
});
