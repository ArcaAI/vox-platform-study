import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { toSafeSession } from '@/server/safe-user';
import { getSession, isElevated } from '@/server/session';
import { PlaygroundTopBar } from '@/features/playground-shared/components/playground-top-bar';
import { Providers } from '@/shared/providers';

/**
 * Minimal playground chrome (TASK-442, spec §8, artboard 4a). The playground is
 * a deliberately focused "impersonation canvas" where an admin acts as an
 * end-user — NO admin sidebar/header. Living OUTSIDE (console), this layout
 * owns everything (console)/layout.tsx provides for the rest of the app: the
 * login-redirect gate, the client <Providers>, and the tier guard.
 *
 * Tier 50–59 (rule 12 §5): renders for the elevated cross-tenant set and for
 * TENANT_ADMIN; everyone else 404s — never 403 — matching the gateway's
 * existence-hiding posture. Pages that need tenant context add
 * <WorkingTenantGate> themselves.
 */
export default async function PlaygroundLayout({ children }: { children: ReactNode }) {
    const session = await getSession();
    if (!session) {
        redirect('/login');
    }
    if (!isElevated(session.user) && !session.user.roles.includes('TENANT_ADMIN')) {
        notFound();
    }
    const safeSession = toSafeSession(session);

    return (
        <Providers>
            {/* Inner-scroll model (rule 11 §1): the wrapper owns the viewport
                height; the slim bar is pinned shrink-0 and only the canvas below
                scrolls. No window scroll — each navigation mounts a fresh
                content region starting at the top. */}
            <div className="flex h-svh flex-col overflow-hidden">
                <PlaygroundTopBar session={safeSession} />
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
            </div>
        </Providers>
    );
}
