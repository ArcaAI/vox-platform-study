import { createFileRoute } from '@tanstack/react-router';
import HarnessOverviewPage from '@/features/admin/harness/overview';

export const Route = createFileRoute('/_authenticated/admin/harness/overview')({
  component: HarnessOverviewPage,
});
