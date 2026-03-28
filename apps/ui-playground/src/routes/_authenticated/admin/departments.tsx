import DepartmentManagementPage from '@/features/admin/departments';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '@/store/auth-store';

function GuardedDepartmentPage() {
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);
  if (!isSuperAdmin()) {
    return <Navigate to="/403" />;
  }
  return <DepartmentManagementPage />;
}

export const Route = createFileRoute('/_authenticated/admin/departments')({
  component: GuardedDepartmentPage,
});
