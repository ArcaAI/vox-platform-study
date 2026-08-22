import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { SidebarTrigger } from '@arcaai/ui/components/shadcn/sidebar';
import type { SafeSession } from '@/shared/auth/hooks';
import { CommandPalette } from '@/shared/layout/command-palette';
import { TenantSwitcher } from '@/shared/layout/tenant-switcher';
import { ThemeToggle } from '@/shared/layout/theme-toggle';
import { UserMenu } from '@/shared/layout/user-menu';
import { Breadcrumbs } from '@/shared/navigation/breadcrumbs';

export function SiteHeader({ session }: { session: SafeSession }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      {/* AC-4/AC-7: the one control that opens the off-canvas navigation below
          `md` and collapses it to the rail above — named for what it does, not
          "Toggle Sidebar". The reference system's equivalent has no accessible
          name at all (its 4.1.2 failure); do not regress this to an icon. */}
      <SidebarTrigger className="-ml-1" aria-label="Toggle navigation" />
      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
      <Breadcrumbs />
      <div className="ml-auto flex items-center gap-2">
        <CommandPalette />
        {session.isElevated ? <TenantSwitcher session={session} /> : null}
        <ThemeToggle />
        <UserMenu session={session} />
      </div>
    </header>
  );
}
