'use client';

import { IconLogout2 } from '@tabler/icons-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import type { SafeSession } from '@/shared/auth/hooks';
import { TenantSwitcher } from '@/shared/layout/tenant-switcher';
import { ThemeToggle } from '@/shared/layout/theme-toggle';
import { UserMenu } from '@/shared/layout/user-menu';
import { matchNavEntry } from '@/shared/navigation/nav-config';
import { PersonaControl } from './persona-control';

/**
 * Slim playground chrome (TASK-442, artboard 4a) — the only bar in the
 * playground layout. Left: "Playground / {page}" (page name from the nav
 * label, so nav = breadcrumb = title). Middle: the persona/impersonation
 * control. Right: Exit → /dashboard, theme, account. Pinned shrink-0 above the
 * scrolling canvas; the single <header> is the layout's only banner landmark.
 */
export function PlaygroundTopBar({ session }: { session: SafeSession }) {
    const pathname = usePathname();
    const pageLabel = matchNavEntry(pathname)?.label ?? 'Playground';

    return (
        <header className="bg-background z-40 flex h-14 shrink-0 items-center gap-3 border-b px-4">
            <div className="flex min-w-0 items-center gap-1.5">
                <span className="text-muted-foreground shrink-0 text-sm">Playground</span>
                <span className="text-muted-foreground shrink-0 text-sm" aria-hidden>
                    /
                </span>
                <span className="truncate text-sm font-medium">{pageLabel}</span>
            </div>
            <Separator orientation="vertical" className="data-[orientation=vertical]:h-5" />
            <PersonaControl session={session} />
            <div className="ml-auto flex shrink-0 items-center gap-2">
                {/* Tenant-scoped playground pages (consultation / live-transcription /
                    dna / llm) use WorkingTenantGate — an elevated admin needs the
                    switcher HERE to pick a working tenant, since the playground has no
                    console sidebar/header (TASK-442). */}
                {session.isElevated ? <TenantSwitcher session={session} /> : null}
                <Button asChild variant="ghost" size="sm">
                    <Link href="/dashboard">
                        <IconLogout2 className="size-4" />
                        Exit
                    </Link>
                </Button>
                <ThemeToggle />
                <UserMenu session={session} />
            </div>
        </header>
    );
}
