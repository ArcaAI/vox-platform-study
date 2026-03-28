import OverviewPage from '@/features/playground/overview';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/playground/overview')({
  component: OverviewPage,
});
