import SystemHealthPage from '@/features/admin/monitoring';
import { RequireGlobalScope } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/system-health')({
  component: () => (
    <RequireGlobalScope>
      <SystemHealthPage />
    </RequireGlobalScope>
  ),
});
