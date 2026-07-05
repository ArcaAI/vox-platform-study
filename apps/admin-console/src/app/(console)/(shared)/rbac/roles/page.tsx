import type { Metadata } from 'next';
import { RolesScreen } from '@/features/rbac/components/roles-screen';

export const metadata: Metadata = {
    title: 'Roles',
};

/** Frame 21 — RBAC Roles (tier 20-29, shared: global + tenant admins). */
export default function RbacRolesPage() {
    return <RolesScreen />;
}
