import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getSession, isElevated } from '@/server/session';

/**
 * Tier 50–59 guard (TASK-420/431, rule 12 §5): the Playground renders for the
 * elevated cross-tenant set and for TENANT_ADMIN. Playground planes run under
 * the admin's OWN account (end-user planes, not /admin/* surfaces); screens
 * that need tenant context add <WorkingTenantGate> themselves. Everyone else
 * 404s — never 403 — matching the gateway's existence-hiding posture.
 */
export default async function PlaygroundTierLayout({ children }: { children: ReactNode }) {
    const session = await getSession();
    if (!isElevated(session?.user) && !session?.user.roles.includes('TENANT_ADMIN')) {
        notFound();
    }
    return children;
}
