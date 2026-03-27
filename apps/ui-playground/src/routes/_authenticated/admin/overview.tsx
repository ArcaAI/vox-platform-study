import AdminOverviewPage from '@/features/admin/overview';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/overview')({
  component: AdminOverviewPage,
});
