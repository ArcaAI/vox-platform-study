import type { Metadata } from 'next';
import { MonitoringScreen } from '@/features/monitoring/components/monitoring-screen';

export const metadata: Metadata = {
  title: 'Monitoring',
};

/** Frame 11 — Monitoring (tier 10, super admins only). */
export default function MonitoringPage() {
  return <MonitoringScreen />;
}
