import type { Metadata } from 'next';
import { PlatformDashboard } from '@/features/platform/components/platform-dashboard';

export const metadata: Metadata = {
    title: 'Platform Dashboard',
};

/** Frame 10 — Platform Dashboard (tier 10, global admins only). */
export default function DashboardPage() {
    return <PlatformDashboard />;
}
