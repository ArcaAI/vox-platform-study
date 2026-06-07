import { createFileRoute } from '@tanstack/react-router';
import HarnessAuditPage from '@/features/admin/harness/audit';

export const Route = createFileRoute('/_authenticated/admin/harness/audit')({
  component: HarnessAuditPage,
});
