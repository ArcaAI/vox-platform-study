import type { Metadata } from 'next';
import { ChangelogScreen } from '@/features/changelog';

export const metadata: Metadata = {
  title: "What's New",
};

/** Tier 20-29 (shared) — release notes visible to global and tenant admins alike. */
export default function ChangelogPage() {
  return <ChangelogScreen />;
}
