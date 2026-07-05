import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { SidebarInset, SidebarProvider } from '@arcaai/ui/components/shadcn/sidebar';
import { toSafeSession } from '@/server/safe-user';
import { getSession } from '@/server/session';
import { AppSidebar } from '@/shared/layout/app-sidebar';
import { ImpersonationBanner, WorkingTenantBanner } from '@/shared/layout/session-banners';
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
                <AppSidebar />
                <SidebarInset>
                    <SiteHeader session={safeSession} />
                    <ImpersonationBanner session={safeSession} />
                    <WorkingTenantBanner session={safeSession} />
                    <div className="flex flex-1 flex-col p-4 md:p-6">{children}</div>
                </SidebarInset>
            </SidebarProvider>
        </Providers>
    );
}
