import type { Metadata } from 'next';
import { PoliciesScreen } from '@/features/rbac/components/policies-screen';

export const metadata: Metadata = {
    title: 'Policies',
};

/** Frame 22 — RBAC Policies (tier 20-29, shared: global + tenant admins). */
export default function RbacPoliciesPage() {
    return <PoliciesScreen />;
}
