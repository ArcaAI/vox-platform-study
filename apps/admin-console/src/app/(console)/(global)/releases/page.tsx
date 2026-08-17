import type { Metadata } from 'next';
import { ReleasesScreen } from '@/features/releases/components/releases-screen';

export const metadata: Metadata = {
  title: 'Releases',
};

/** Platform Releases (tier 10-19, super admins, cross-tenant). */
export default function ReleasesPage() {
  return <ReleasesScreen />;
}
