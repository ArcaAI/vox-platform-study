import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AudioWaveform,
  Building2,
  Component,
  Database,
  Fingerprint,
  FolderTree,
  Gauge,
  History,
  KeyRound,
  Layers,
  LayoutDashboard,
  Radio,
  ScrollText,
  Settings,
  Shield,
  ShieldAlert,
  Sparkles,
  Stethoscope,
  Users,
} from 'lucide-react';
import { isSuperAdmin, isTenantAdmin } from '@/features/tenants/permissions';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Short caption shown under the section, mirrors TASK-371 pillars. */
  description?: string;
  /** Default-deny RBAC (X5): when true, only platform super-admins see the item. */
  requireSuperAdmin?: boolean;
  /**
   * Admin-tier gate (TASK-391 follow-up): when true, the item is visible to
   * tenant-admins **and** super-admins (but not regular users) — they
   * legitimately manage their own tenant's data. Mirrors the server CASL as a
   * visibility hint only; same default-deny pattern as {@link requireSuperAdmin}.
   */
  requireAdmin?: boolean;
}

export interface NavSection {
  /** Design-aligned tier label (TASK-371 §5.12). */
  title: string;
  items: NavItem[];
}

/**
 * Role-tiered navigation (TASK-379). Tiers mirror the design's section labels;
 * the **Platform** tier (cross-tenant tenant management) is super-admin only, so
 * a tenant-admin's nav is scoped to their own workspace. Only routes that exist
 * today are listed (no placeholders for unbuilt Dashboard/Queues surfaces).
 */
const ALL_SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [{ label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard, description: 'Cross-tenant platform overview', requireSuperAdmin: true }],
  },
  {
    title: 'Platform',
    items: [{ label: 'Tenants', to: '/tenants', icon: Building2, description: 'Organizations on the platform', requireSuperAdmin: true }],
  },
  {
    // TASK-403 — the design's OPERATIONS tier (§2 nav contract): the three
    // platform-operator surfaces, all super-admin only.
    title: 'Operations',
    items: [
      { label: 'Rate Limits', to: '/rate-limits', icon: ShieldAlert, description: 'Gateway throttling, live and DB-backed', requireSuperAdmin: true },
      { label: 'Queues & Jobs', to: '/queues', icon: Layers, description: 'BullMQ queues, jobs and Redis health', requireSuperAdmin: true },
      { label: 'Prisma Studio', to: '/prisma-studio', icon: Database, description: 'Dev-only database browser link-out', requireSuperAdmin: true },
    ],
  },
  {
    title: 'Identity & Access',
    items: [
      { label: 'Users', to: '/users', icon: Users, description: 'People and service accounts' },
      { label: 'Roles & Policies', to: '/roles', icon: Shield, description: 'RBAC and CASL policies', requireSuperAdmin: true },
      { label: 'API Keys', to: '/api-keys', icon: KeyRound, description: 'Programmatic credentials', requireAdmin: true },
    ],
  },
  {
    title: 'Clinical Operations',
    items: [
      { label: 'Departments & Prompts', to: '/departments', icon: FolderTree, description: 'Departments and prompt templates' },
      { label: 'Consultation History', to: '/history', icon: History, description: 'Context timeline by consultation' },
      { label: 'Live Session', to: '/live', icon: Radio, description: 'Realtime transcript capture' },
    ],
  },
  {
    title: 'Observability',
    items: [
      { label: 'Audit Log', to: '/audit-log', icon: ScrollText, description: 'Tenant activity, keyset-paginated', requireAdmin: true },
      { label: 'Monitoring', to: '/system-health', icon: Activity, description: 'Service health, latency and throughput', requireSuperAdmin: true },
    ],
  },
  {
    title: 'Settings',
    items: [
      // TASK-392 — super-admins get the full plan-matrix + per-tenant tools;
      // tenant-admins see their own read-only capability/usage snapshot.
      { label: 'Entitlements', to: '/entitlements', icon: Gauge, description: 'Plan limits, usage and overrides', requireAdmin: true },
      { label: 'Settings', to: '/settings', icon: Settings, description: 'Global and personal settings', requireSuperAdmin: true },
    ],
  },
  {
    // TASK-408 — the design taxonomy's 50–59 Playground tier ("admins
    // exploring the apps"): admin-gated like the 20–29 shared tier. Screen
    // 51 (Live Transcription) is served by the existing `/live` entry under
    // Clinical Operations (additive-nav constraint — see the TASK-408 doc).
    title: 'Playground',
    items: [
      {
        label: 'Clinical Consultation',
        to: '/playground/consultation',
        icon: Stethoscope,
        description: 'Consultation lifecycle explorer',
        requireAdmin: true,
      },
      {
        label: 'Voice Profile',
        to: '/playground/voice-profile',
        icon: AudioWaveform,
        description: 'Speaker enrollment for diarization',
        requireAdmin: true,
      },
      {
        label: 'DNA Writing Style',
        to: '/playground/dna-style',
        icon: Fingerprint,
        description: 'Personalized writing-style profiles',
        requireAdmin: true,
      },
      { label: 'Summarization', to: '/playground/summarization', icon: Sparkles, description: 'SMR sandbox over a consultation', requireAdmin: true },
    ],
  },
  {
    // TASK-403 — super-admin/dev tier. The `/components` route file is owned
    // by a sibling worker (parallel ticket); only this nav entry lives here.
    title: 'Developer',
    items: [{ label: 'Components', to: '/components', icon: Component, description: 'UI component library showcase', requireSuperAdmin: true }],
  },
];

/** Sections + items filtered to the viewer's role (default-deny). Empty sections drop out. */
export function getNavSections(roles?: string[] | null): NavSection[] {
  const superAdmin = isSuperAdmin(roles);
  const admin = superAdmin || isTenantAdmin(roles);
  const canSee = (item: NavItem): boolean => {
    if (item.requireSuperAdmin) return superAdmin;
    if (item.requireAdmin) return admin;
    return true;
  };
  return ALL_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(canSee),
  })).filter((section) => section.items.length > 0);
}

/** Flat list of every nav item (role-agnostic) for active-title / label lookups. */
export const NAV_ITEMS: NavItem[] = ALL_SECTIONS.flatMap((s) => s.items);
