import type { Metadata } from 'next';
import { TenantSttConfigScreen } from '@/features/tenant-stt-config/components/tenant-stt-config-screen';

export const metadata: Metadata = { title: 'STT Configuration' };

/**
 * Tenant STT configuration (tier 30-49, working tenant). Composed from the
 * already-approved patterns (ScreenTemplate, WorkingTenantGate + acting-on
 * gate, the TTS CredentialCard tab shape, OccConflictAlert) — the Figma
 * design gate for this screen was explicitly waived by the owner.
 */
export default function SttConfigPage() {
  return <TenantSttConfigScreen />;
}
