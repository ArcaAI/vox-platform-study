import type { Metadata } from 'next';
import { TenantTtsConfigScreen } from '@/features/tenant-tts-config/components/tenant-tts-config-screen';

export const metadata: Metadata = { title: 'TTS Configuration' };

/** Tenant TTS configuration (tier 30-49, working tenant). */
export default function TtsConfigPage() {
    return <TenantTtsConfigScreen />;
}
