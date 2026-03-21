import TenantManagementPage from '@/features/admin/tenants';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '@/store/auth-store';

function GuardedTenantPage() {
    const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);
    if (!isSuperAdmin()) {
        return <Navigate to="/403" />;
    }
    return <TenantManagementPage />;
}

export const Route = createFileRoute('/_authenticated/admin/tenants')({
    component: GuardedTenantPage,
});
