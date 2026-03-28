import UserManagementPage from '@/features/admin/users';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '@/store/auth-store';

function GuardedUserPage() {
  const roles = useAuthStore((s) => s.user?.roles ?? []);
  const canAccess = roles.some((r) => ['SUPER_ADMIN', 'GLOBAL_ADMIN', 'TENANT_ADMIN'].includes(r));
  if (!canAccess) {
    return <Navigate to="/403" />;
  }
  return <UserManagementPage />;
}

export const Route = createFileRoute('/_authenticated/admin/users')({
  component: GuardedUserPage,
});
