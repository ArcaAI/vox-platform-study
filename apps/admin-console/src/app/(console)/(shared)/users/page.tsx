import type { Metadata } from 'next';
import { UsersListScreen } from '@/features/users/components/users-list-screen';

export const metadata: Metadata = { title: 'Users' };

/** Frame 20 — Users list (tier 20-29, shared). */
export default function UsersPage() {
    return <UsersListScreen />;
}
