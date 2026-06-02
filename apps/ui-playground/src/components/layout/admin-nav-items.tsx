import { Building2, Database, Dna, FileText, HardDrive, Hospital, ScrollText, Server, Settings, Settings2, SlidersHorizontal, Users, Workflow } from 'lucide-react';
import { orderItemsById } from '@/features/admin/hooks/use-admin-preferences';
import type { DraggableNavItem } from './draggable-nav-group';

/**
 * TASK-327 T5 — admin nav is scope-driven, not visibility-driven.
 *
 * Any admin (SUPER_ADMIN / GLOBAL_ADMIN / TENANT_ADMIN — `isAdmin`) sees the
 * full admin menu set; data is scoped server-side by the `X-Tenant-Id`
 * header, so there's no need to HIDE menus per role. The one exception is
 * Prisma Studio, which stays global-scope only (TASK-326 Q4) and is gated by
 * `isGlobalScope`.
 *
 * The resulting list is ordered by the caller's persisted preference
 * (`orderItemsById`); unknown / not-yet-saved ids fall back to this build
 * order at the end.
 */
export function buildAdminNavItems(opts: { isAdmin: boolean; isGlobalScope: boolean; order: readonly string[] }): DraggableNavItem[] {
  const { isAdmin, isGlobalScope, order } = opts;

  const items: DraggableNavItem[] = [{ id: 'overview', title: 'Overview', url: '/', icon: Settings }];

  if (isAdmin) {
    items.push(
      { id: 'dna-reports', title: 'DNA Reports', url: '/admin/dna-reports', icon: Dna, badge: 'NEW' },
      { id: 'tenants', title: 'Tenants', url: '/admin/tenants', icon: Building2 },
      { id: 'users', title: 'Users', url: '/admin/users', icon: Users },
      { id: 'prompts', title: 'Prompts', url: '/admin/prompts', icon: FileText, badge: 'NEW' },
      { id: 'departments', title: 'Departments', url: '/admin/departments', icon: Hospital, badge: 'NEW' },
      { id: 'audio-pipelines', title: 'Audio Pipelines', url: '/admin/audio-pipelines', icon: Workflow, badge: 'NEW' },
      { id: 'frontend-pipeline', title: 'Frontend Pipeline', url: '/admin/frontend-pipeline', icon: SlidersHorizontal, badge: 'NEW' },
      { id: 'backend-pipeline', title: 'Backend Pipeline', url: '/admin/backend-pipeline', icon: Server, badge: 'NEW' },
      { id: 'storage', title: 'Storage', url: '/admin/storage', icon: HardDrive },
      { id: 'configurations', title: 'Configurations', url: '/admin/configurations', icon: Settings2 },
      { id: 'audit-logs', title: 'Audit Logs', url: '/admin/audit-logs', icon: ScrollText },
    );
  }

  // Prisma Studio — global scope only (super-admin / global-admin).
  if (isGlobalScope) {
    items.push({ id: 'studio', title: 'Prisma Studio', url: '/admin/studio', icon: Database });
  }

  return orderItemsById(items, order);
}
