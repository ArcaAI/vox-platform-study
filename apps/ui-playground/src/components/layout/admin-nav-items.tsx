import { Building2, Database, Dna, FileText, HardDrive, Hospital, ScrollText, Server, Settings, Settings2, SlidersHorizontal, Users, Workflow } from 'lucide-react';
import { orderItemsById } from '@/features/admin/hooks/use-admin-preferences';
import type { DraggableNavItem } from './draggable-nav-group';

/**
 * TASK-327 T5 — admin nav is scope-driven, not visibility-driven.
 *
 * Any admin (SUPER_ADMIN / TENANT_ADMIN — `isAdmin`) sees the full admin menu
 * set; data is scoped server-side by the `X-Tenant-Id` header, so there's no
 * need to HIDE menus per role. The one exception is Prisma Studio, which stays
 * global-scope only (TASK-326 Q4) and is gated by `isGlobalScope`.
 *
 * TASK-331 #1 — a global-scope admin (SUPER_ADMIN) has no implicit tenant, so
 * the tenant-scoped pages are DISABLED until they pick one in the header
 * ScopeSwitcher. The Overview, the Tenants management area, the cross-tenant
 * Users directory and the global Prisma Studio stay enabled so the admin can
 * reach the tenant picker and operate cross-tenant. A TENANT_ADMIN is always
 * bound to their session tenant, so nothing is gated for them.
 *
 * The resulting list is ordered by the caller's persisted preference
 * (`orderItemsById`); unknown / not-yet-saved ids fall back to this build
 * order at the end.
 */
const TENANT_SCOPED_ADMIN_IDS = new Set([
  'dna-reports',
  'prompts',
  'departments',
  'audio-pipelines',
  'frontend-pipeline',
  'backend-pipeline',
  'storage',
  'configurations',
  'audit-logs',
]);

export function buildAdminNavItems(opts: {
  isAdmin: boolean;
  isGlobalScope: boolean;
  tenantSelected: boolean;
  order: readonly string[];
}): DraggableNavItem[] {
  const { isAdmin, isGlobalScope, tenantSelected, order } = opts;

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

  // Prisma Studio — global scope only (super-admin).
  if (isGlobalScope) {
    items.push({ id: 'studio', title: 'Prisma Studio', url: '/admin/studio', icon: Database });
  }

  // Gate tenant-scoped pages behind a selected tenant for a global-scope admin.
  const gated =
    isGlobalScope && !tenantSelected
      ? items.map((item) =>
          TENANT_SCOPED_ADMIN_IDS.has(item.id)
            ? { ...item, disabled: true, disabledReason: 'Select a tenant first to manage tenant-scoped resources' }
            : item,
        )
      : items;

  return orderItemsById(gated, order);
}
