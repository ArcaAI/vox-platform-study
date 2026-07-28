import type { Metadata } from 'next';
import { TenantSttConfigScreen } from '@/features/tenant-stt-config/components/tenant-stt-config-screen';

export const metadata: Metadata = { title: 'STT Configuration' };

/**
 * Tenant STT configuration (tier 30-49, working tenant).
 *
 * ⚠️ DESIGN GATE OPEN (rule 12) — DO NOT MERGE. No approved Figma frame and no
 * recorded owner waiver exist yet. The route is intentionally NOT wired into the
 * sidebar nav; it is reachable only by direct URL until the owner grants a frame
 * or records a waiver. See the ticket README (Phase G).
 */
export default function SttConfigPage() {
    return <TenantSttConfigScreen />;
}
