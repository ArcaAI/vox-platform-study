import { Avatar, AvatarFallback } from '@arcaai/ui/avatar';
import { Button } from '@arcaai/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@arcaai/ui/dropdown-menu';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@arcaai/ui/sheet';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { LogOut, Menu, Monitor, Moon, Rows2, Rows3, Sun } from 'lucide-react';
import { useAuth } from '@arcaai/vox';
import { useState } from 'react';
import { NAV_SECTIONS } from '@/lib/nav';
import { useAppDensity } from '@/providers/density-provider';
import { useTheme } from '@/providers/theme-provider';
import { useAuthStore } from '@/store/auth-store';
import { initialsOf } from '@/lib/utils';

function BrandMark() {
    return (
        <Link to="/tenants" className="flex items-center gap-2.5 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring rounded-md">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-lg font-semibold text-primary-foreground">+</span>
            <span className="flex flex-col leading-tight">
                <span className="text-sm font-semibold text-sidebar-foreground">HOPE</span>
                <span className="text-xs text-muted-foreground">Admin Console</span>
            </span>
        </Link>
    );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
    return (
        <nav className="flex flex-col gap-5 px-2" aria-label="Primary">
            {NAV_SECTIONS.map((section) => (
                <div key={section.title} className="flex flex-col gap-1">
                    <p className="px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">{section.title}</p>
                    {section.items.map((item) => (
                        <Link
                            key={item.to}
                            to={item.to}
                            onClick={onNavigate}
                            className="group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[status=active]:bg-sidebar-accent data-[status=active]:text-sidebar-accent-foreground"
                            activeProps={{ 'data-status': 'active' }}
                        >
                            <item.icon className="size-4 shrink-0" aria-hidden />
                            <span className="truncate">{item.label}</span>
                        </Link>
                    ))}
                </div>
            ))}
        </nav>
    );
}

function ThemeToggle() {
    const { theme, setTheme } = useTheme();
    const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
    const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
    return (
        <Button variant="ghost" size="icon" className="size-9" onClick={() => setTheme(next)} title={`Theme: ${theme}`} aria-label={`Theme: ${theme}. Switch to ${next}.`}>
            <Icon className="size-4" />
        </Button>
    );
}

function DensityToggle() {
    const { density, toggle } = useAppDensity();
    return (
        <Button
            variant="ghost"
            size="icon"
            className="size-9"
            onClick={toggle}
            title={`Density: ${density}`}
            aria-pressed={density === 'compact'}
            aria-label={density === 'compact' ? 'Switch to comfortable density' : 'Switch to compact density'}
        >
            {density === 'compact' ? <Rows3 className="size-4" /> : <Rows2 className="size-4" />}
        </Button>
    );
}

function UserMenu() {
    const user = useAuthStore((s) => s.user);
    const storeLogout = useAuthStore((s) => s.logout);
    const { logout, isImpersonating } = useAuth();

    const onLogout = async () => {
        try {
            await logout();
        } catch {
            // server logout best-effort; clear locally regardless
        }
        storeLogout();
        window.location.assign('/login');
    };

    const label = user?.username || user?.email || 'Account';
    const role = user?.roles?.[0]?.replace(/_/g, ' ').toLowerCase();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-9 gap-2 px-2" aria-label="Account menu">
                    <Avatar className="size-7">
                        <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">{initialsOf(label)}</AvatarFallback>
                    </Avatar>
                    <span className="hidden max-w-32 truncate text-sm font-medium sm:inline">{label}</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="flex flex-col gap-1">
                    <span className="truncate">{label}</span>
                    {user?.email && user.email !== label ? <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span> : null}
                    {role ? <span className="text-xs font-normal capitalize text-muted-foreground">{role}</span> : null}
                </DropdownMenuLabel>
                {isImpersonating ? (
                    <>
                        <DropdownMenuSeparator />
                        <div className="px-2 py-1">
                            <StatusBadge label="Impersonating" colorRole="warning" />
                        </div>
                    </>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onLogout} className="text-destructive focus:text-destructive">
                    <LogOut className="size-4" />
                    Sign out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function useActiveTitle(): string {
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    for (const section of NAV_SECTIONS) {
        const match = section.items.find((i) => pathname.startsWith(i.to));
        if (match) return match.label;
    }
    return 'Admin Console';
}

/** Sidebar + topbar application shell (TASK-371 layout, token-driven). */
export function AppShell() {
    const [mobileOpen, setMobileOpen] = useState(false);
    const title = useActiveTitle();

    return (
        <div className="flex h-svh w-full overflow-hidden bg-background">
            <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
                <div className="flex h-14 items-center border-b border-sidebar-border px-3">
                    <BrandMark />
                </div>
                <ScrollArea className="flex-1 py-4">
                    <SidebarNav />
                </ScrollArea>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card/60 px-3 backdrop-blur supports-[backdrop-filter]:bg-card/60 sm:px-4">
                    <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                        <SheetTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-9 md:hidden" aria-label="Open navigation">
                                <Menu className="size-5" />
                            </Button>
                        </SheetTrigger>
                        <SheetContent side="left" className="w-72 bg-sidebar p-0">
                            <SheetTitle className="sr-only">Navigation</SheetTitle>
                            <div className="flex h-14 items-center border-b border-sidebar-border px-3">
                                <BrandMark />
                            </div>
                            <ScrollArea className="h-[calc(100svh-3.5rem)] py-4">
                                <SidebarNav onNavigate={() => setMobileOpen(false)} />
                            </ScrollArea>
                        </SheetContent>
                    </Sheet>

                    <h1 className="truncate text-base font-semibold">{title}</h1>

                    <div className="ml-auto flex items-center gap-1">
                        <ThemeToggle />
                        <DensityToggle />
                        <UserMenu />
                    </div>
                </header>

                <main className="min-h-0 flex-1 overflow-auto">
                    <div className="mx-auto w-full max-w-[1400px] p-4 sm:p-6">
                        <Outlet />
                    </div>
                </main>
            </div>
        </div>
    );
}
