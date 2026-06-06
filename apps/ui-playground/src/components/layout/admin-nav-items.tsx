import {
  Activity,
  Building2,
  ClipboardList,
  Database,
  Dna,
  FileText,
  Gauge,
  HardDrive,
  Hospital,
  Layers,
  ScrollText,
  Settings,
  Settings2,
  Users,
  Workflow,
} from 'lucide-react';
import { orderItemsById } from '@/features/admin/hooks/use-admin-preferences';
import type { DraggableNavItem } from './draggable-nav-group';

/**
 * TASK-327 T5 — admin nav is scope-driven, not visibility-driven.
 *
 * Any admin (SUPER_ADMIN / TENANT_ADMIN — `isAdmin`) sees the full admin menu
 * set; data is scoped server-side by the `X-Tenant-Id` header, so there's no
 * need to HIDE menus per role. The exceptions are the global-scope-only ops
 * surfaces — Prisma Studio (TASK-326 Q4), System Health (TASK-336 OB-01),
 * Rate Limits (TASK-336 IC-05) and Queues & Jobs (TASK-336 OB-03 / TASK-250) —
 * which are gated by `isGlobalScope`. Rate Limits, Queues & Jobs and the
 * scheduler controls all back SUPER_ADMIN-only controllers over platform-wide
 * infrastructure; System Health is a platform-wide read. None needs a selected
 * tenant, so they are not in the tenant-scoped gating set below.
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
  'storage',
  'configurations',
  'audit-logs',
  'jobs',
]);

export function buildAdminNavItems(opts: {
  isAdmin: boolean;
  isGlobalScope: boolean;
  tenantSelected: boolean;
  order: readonly string[];
}): DraggableNavItem[] {
  const { isAdmin, isGlobalScope, tenantSelected, order } = opts;

  const items: DraggableNavItem[] = [];

  if (isAdmin) {
    items.push(
      { id: 'overview', title: 'Overview', url: '/', icon: Settings },
      { id: 'dna-reports', title: 'DNA Reports', url: '/admin/dna-reports', icon: Dna, badge: 'NEW' },
      { id: 'tenants', title: 'Tenants', url: '/admin/tenants', icon: Building2 },
      { id: 'users', title: 'Users', url: '/admin/users', icon: Users },
      { id: 'prompts', title: 'Prompts', url: '/admin/prompts', icon: FileText, badge: 'NEW' },
      { id: 'departments', title: 'Departments', url: '/admin/departments', icon: Hospital, badge: 'NEW' },
      { id: 'audio-pipelines', title: 'Audio Pipelines', url: '/admin/audio-pipelines', icon: Workflow, badge: 'NEW' },
      { id: 'storage', title: 'Storage', url: '/admin/storage', icon: HardDrive },
      { id: 'configurations', title: 'Configurations', url: '/admin/configurations', icon: Settings2 },
      { id: 'audit-logs', title: 'Audit Logs', url: '/admin/audit-logs', icon: ScrollText },
      // TASK-336 OB-02 — tenant-wide consultations + transcription jobs.
      { id: 'jobs', title: 'Jobs', url: '/admin/jobs', icon: ClipboardList },
    );
  }

  // Global-scope-only ops surfaces (super-admin). System Health, Rate Limits
  // and Queues & Jobs (TASK-336 OB-01 / IC-05 / OB-03) join Prisma Studio here;
  // ordering is resolved by `orderItemsById` below, which keeps Prisma Studio
  // segregated last.
  if (isGlobalScope) {
    items.push(
      { id: 'system-health', title: 'System Health', url: '/admin/system-health', icon: Activity },
      { id: 'rate-limits', title: 'Rate Limits', url: '/admin/rate-limits', icon: Gauge },
      // TASK-336 OB-03 / TASK-250 — platform BullMQ queues, jobs and schedulers.
      { id: 'queues', title: 'Queues & Jobs', url: '/admin/queues', icon: Layers },
      { id: 'studio', title: 'Prisma Studio', url: '/admin/studio', icon: Database },
    );
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
