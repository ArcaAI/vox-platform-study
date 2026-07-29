import type { Metadata } from 'next';
import { DepartmentsScreen } from '@/features/departments/components/departments-screen';

export const metadata: Metadata = { title: 'Departments' };

/** Frame 30 — Departments (tier 30-49, working-tenant scoped). */
export default function DepartmentsPage() {
  return <DepartmentsScreen />;
}
