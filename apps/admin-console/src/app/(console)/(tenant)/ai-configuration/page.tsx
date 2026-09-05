import type { Metadata } from 'next';
import { SpeechAndVoiceScreen } from '@/features/tenant-stt-config/components/speech-and-voice-screen';

export const metadata: Metadata = { title: 'Speech & Voice' };

/**
 * Tenant Speech & Voice configuration (tier 30-49, working tenant): the STT
 * fallback pointer, and the way through to the text-to-speech agents.
 *
 * DEPRECATED (TASK-862, removed in R4): the remaining binding retires with the
 * ASR Agent; this route then becomes a one-release `redirect('/agents')`. The
 * TTS half already has (TASK-888 dropped `TenantTtsConfig`), and provider keys
 * already live on `/ai-providers`.
 */
export default function AiConfigurationPage() {
  return <SpeechAndVoiceScreen />;
}
