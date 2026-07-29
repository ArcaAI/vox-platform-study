import type { Metadata } from 'next';
import { AuditLogsScreen } from '@/features/audit-logs/components/audit-logs-screen';

export const metadata: Metadata = {
  title: 'Audit logs',
};

export default function AuditLogsPage() {
  return <AuditLogsScreen />;
}
