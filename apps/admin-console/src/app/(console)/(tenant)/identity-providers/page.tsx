import type { Metadata } from 'next';
import { IdentityProvidersScreen } from '@/features/identity-providers/components/identity-providers-screen';

export const metadata: Metadata = { title: 'Identity Providers' };

/** TASK-498 P4 — tenant-scoped external identity provider (OIDC) administration (tier 30-49). */
export default function IdentityProvidersPage() {
    return <IdentityProvidersScreen />;
}
