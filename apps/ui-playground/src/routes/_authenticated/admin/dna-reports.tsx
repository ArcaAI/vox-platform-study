import DnaReportsAdminPage from '@/features/admin/dna-reports';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '@/store/auth-store';

function GuardedDnaReportsPage() {
  const roles = useAuthStore((s) => s.user?.roles ?? []);
  const isAllowed = roles.includes('SUPER_ADMIN') || roles.includes('GLOBAL_ADMIN') || roles.includes('TENANT_ADMIN');

  if (!isAllowed) {
    return <Navigate to="/403" />;
  }

  return <DnaReportsAdminPage />;
}

export const Route = createFileRoute('/_authenticated/admin/dna-reports')({
  component: GuardedDnaReportsPage,
});
