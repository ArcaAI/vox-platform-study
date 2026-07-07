import type { Metadata } from 'next';
import { VoiceProfilesScreen } from '@/features/playground-voice-profiles/components/voice-profiles-screen';

export const metadata: Metadata = { title: 'Voice Profiles' };

/** Frame 52 — own-account voice biometric enrollment (tier 50-59, matrix row 36). */
export default function VoiceProfilesPage() {
    return <VoiceProfilesScreen />;
}
