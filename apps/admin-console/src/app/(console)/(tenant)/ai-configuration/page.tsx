import type { Metadata } from 'next';
import { SpeechAndVoiceScreen } from '@/features/tenant-tts-config/components/speech-and-voice-screen';

export const metadata: Metadata = { title: 'Speech & Voice' };

/**
 * Tenant Speech & Voice configuration (tier 30-49, working tenant): the STT
 * fallback pointer and the TTS voice/language bindings.
 *
 * DEPRECATED (TASK-862, removed in R4): both bindings retire with the ASR and
 * TTS Agents (TASK-861/863); this route then becomes a one-release
 * `redirect('/agents')`. Provider keys already live on `/ai-providers`.
 */
export default function AiConfigurationPage() {
  return <SpeechAndVoiceScreen />;
}
