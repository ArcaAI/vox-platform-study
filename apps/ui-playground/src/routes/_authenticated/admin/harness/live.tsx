import { createFileRoute } from '@tanstack/react-router';
import HarnessLivePage from '@/features/admin/harness/live';

export const Route = createFileRoute('/_authenticated/admin/harness/live')({
  component: HarnessLivePage,
});
