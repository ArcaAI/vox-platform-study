import type { Metadata } from 'next';
import { VoiceProfilesScreen } from '@/features/playground-voice-profiles/components/voice-profiles-screen';

export const metadata: Metadata = { title: 'My Voice Enrollment & Profiles' };

/** Frame 52 / artboard 4d — own-account voice enrollment & profiles (tier 50-59, matrix row 36). */
export default function VoiceProfilesPage() {
  return <VoiceProfilesScreen />;
}
