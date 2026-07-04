import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { SidebarTrigger } from '@arcaai/ui/components/shadcn/sidebar';
import type { SafeSession } from '@/shared/auth/hooks';
import { TenantSwitcher } from '@/shared/layout/tenant-switcher';
import { ThemeToggle } from '@/shared/layout/theme-toggle';
import { UserMenu } from '@/shared/layout/user-menu';

export function SiteHeader({ session }: { session: SafeSession }) {
    return (
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
            <div className="ml-auto flex items-center gap-2">
                {session.isElevated ? <TenantSwitcher session={session} /> : null}
                <ThemeToggle />
                <UserMenu session={session} />
            </div>
        </header>
    );
}
