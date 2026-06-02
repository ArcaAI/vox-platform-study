import FrontendPipelinePage from '@/features/admin/frontend-pipeline';
import { RequireAdmin } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/frontend-pipeline')({
  component: () => (
    <RequireAdmin>
      <FrontendPipelinePage />
    </RequireAdmin>
  ),
});
