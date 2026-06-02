import BackendPipelinePage from '@/features/admin/backend-pipeline';
import { RequireAdmin } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/backend-pipeline')({
  component: () => (
    <RequireAdmin>
      <BackendPipelinePage />
    </RequireAdmin>
  ),
});
