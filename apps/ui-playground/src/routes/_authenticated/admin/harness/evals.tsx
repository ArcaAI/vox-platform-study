import { createFileRoute } from '@tanstack/react-router';
import HarnessEvalsPage from '@/features/admin/harness/evals';

export const Route = createFileRoute('/_authenticated/admin/harness/evals')({
  component: HarnessEvalsPage,
});
