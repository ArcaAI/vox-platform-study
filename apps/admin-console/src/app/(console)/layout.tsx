import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { SidebarInset, SidebarProvider } from '@arcaai/ui/components/shadcn/sidebar';
import { toSafeSession } from '@/server/safe-user';
import { getSession } from '@/server/session';
import { AppSidebar } from '@/shared/layout/app-sidebar';
import { ImpersonationBanner, WorkingTenantBanner } from '@/shared/layout/session-banners';
import { SidebarTierSync } from '@/shared/layout/sidebar-tier-sync';
import { SiteHeader } from '@/shared/layout/site-header';
import { Providers } from '@/shared/providers';

/**
 * Session-gated console chrome. proxy.ts only checks cookie PRESENCE; this
 * layout is the first place the cookie is actually decrypted, so a forged or
 * expired cookie lands back on /login here.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
    const session = await getSession();
    if (!session) {
        redirect('/login');
    }
    const safeSession = toSafeSession(session);

    return (
        <Providers>
            <SidebarProvider>
                <SidebarTierSync />
                <AppSidebar />
                <SidebarInset className="h-svh overflow-hidden">
                    {/* /: topbar + session banners are shell chrome,
                        pinned ABOVE the scroll boundary (frame 07; rule 11 §App Shell).
                        The inset owns the height (h-svh overflow-hidden) so the window
                        never scrolls; only the region below does. */}
                    <div className="bg-background relative z-40 shrink-0">
                        <SiteHeader session={safeSession} />
                        <ImpersonationBanner session={safeSession} />
                        <WorkingTenantBanner session={safeSession} />
                    </div>
                    {/* Content region = the scroll area. Non-list pages scroll here;
                        list pages fill it with a fill-height AdminDataGrid whose body
                        scrolls internally (so this wrapper has nothing to scroll). */}
                    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6">{children}</div>
                </SidebarInset>
            </SidebarProvider>
        </Providers>
    );
}
