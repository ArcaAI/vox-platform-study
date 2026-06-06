import QueuesPage from '@/features/admin/queues';
import { RequireGlobalScope } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/queues')({
  component: () => (
    <RequireGlobalScope>
      <QueuesPage />
    </RequireGlobalScope>
  ),
});
