import type { Metadata } from 'next';
import { SettingsScreen } from '@/features/settings/components/settings-screen';

export const metadata: Metadata = {
    title: 'Settings & secrets',
};

/** Frame 24 — Settings & secrets (tier 20-29 shared; reveal is global-admin only). */
export default function SettingsPage() {
    return <SettingsScreen />;
}
