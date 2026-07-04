import { IconLayoutDashboard } from '@tabler/icons-react';
import type { Metadata } from 'next';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/components/shadcn/empty';

export const metadata: Metadata = {
    title: 'Dashboard',
};

/**
 * Placeholder landing. Feature screens (capability tiers 10-49) are blocked
 * behind the Figma design gate — no fake data before that.
 */
export default function DashboardPage() {
    return (
        <div className="flex flex-1 items-center justify-center">
            <Empty>
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <IconLayoutDashboard />
                    </EmptyMedia>
                    <EmptyTitle>Dashboard</EmptyTitle>
                    <EmptyDescription>Screens land after the design gate. The console foundation is ready.</EmptyDescription>
                </EmptyHeader>
            </Empty>
        </div>
    );
}
