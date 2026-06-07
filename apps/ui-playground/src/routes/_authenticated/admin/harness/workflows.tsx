import { createFileRoute } from '@tanstack/react-router';
import HarnessWorkflowsPage from '@/features/admin/harness/workflows';

export const Route = createFileRoute('/_authenticated/admin/harness/workflows')({
  component: HarnessWorkflowsPage,
});
