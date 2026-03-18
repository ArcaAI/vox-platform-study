import { AppSidebar } from '@/components/layout/app-sidebar';
import { DocPanelRoot } from '@/features/doc-panel';
import { usePlaygroundStore } from '@/store/playground-store';
import { SidebarInset, SidebarProvider } from '@arcaai/ui/sidebar';
import { Outlet } from '@tanstack/react-router';
import { Header } from './header';

export function AuthLayout({ children }: { children?: React.ReactNode }) {
    const sidebarOpen = usePlaygroundStore((s) => s.sidebarOpen);
    const setSidebarOpen = usePlaygroundStore((s) => s.setSidebarOpen);

    return (
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <AppSidebar />
            <SidebarInset>
                <Header fixed />
                {children ?? <Outlet />}
            </SidebarInset>
            <DocPanelRoot />
        </SidebarProvider>
    );
}
