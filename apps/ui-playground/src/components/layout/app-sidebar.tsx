import { useAdminPreferences } from '@/features/admin/hooks/use-admin-preferences';
import { useAuthStore } from '@/store/auth-store';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarRail } from '@arcaai/ui/sidebar';
import { BookOpen, Brain, Dna, Download, FileText, Fingerprint, Headphones, LayoutDashboard, MessageSquare, Zap } from 'lucide-react';
import { useMemo } from 'react';
import { buildAdminNavItems } from './admin-nav-items';
import { DraggableNavGroup } from './draggable-nav-group';
import { NavGroup, type NavItem } from './nav-group';
import { NavUser } from './nav-user';

const documentItems: NavItem[] = [
  {
    title: 'Introduction',
    url: '/introduction',
    icon: BookOpen,
  },
  {
    title: 'Installation',
    url: '/installation',
    icon: Download,
    children: [
      { title: 'Overview', url: '/installation' },
      { title: '@arcaai/room', url: '/installation/room' },
      { title: '@arcaai/stt', url: '/installation/stt' },
      { title: '@arcaai/vad', url: '/installation/vad' },
      { title: '@arcaai/noise-filter', url: '/installation/noise-filter' },
    ],
  },
];

const playgroundItems: NavItem[] = [
  {
    title: 'Overview',
    url: '/playground/overview',
    icon: LayoutDashboard,
  },
  {
    title: 'Consultation',
    url: '/consultation',
    icon: MessageSquare,
  },
  {
    title: 'Audio & Transcription',
    url: '/audio/live-transcription',
    icon: Headphones,
    children: [
      { title: 'Live Transcription', url: '/audio/live-transcription' },
      { title: 'Job Transcription', url: '/audio/job-transcription' },
    ],
  },
  {
    title: 'Voice Profile',
    url: '/voice-profile',
    icon: Fingerprint,
    badge: 'NEW',
  },
  {
    title: 'DNA Writing Style',
    url: '/dna-writing-style',
    icon: Dna,
  },
  {
    title: 'Pre-Summary',
    url: '/summarization/pre-summary',
    icon: Brain,
  },
  {
    title: 'Summary',
    url: '/summarization/summary',
    icon: FileText,
  },
];

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  // TASK-327 T5 — scope, not visibility. Any admin (SA/GA/TA) sees the full
  // admin menu; per-tenant data scoping is enforced server-side via
  // X-Tenant-Id. Prisma Studio remains global-scope only. Both predicates are
  // sourced from the auth store so the nav and the route guards
  // (`RequireAdmin` / `RequireGlobalScope`) share one definition.
  const isAdmin = useAuthStore((s) => s.isAdmin());
  const isGlobalScope = useAuthStore((s) => s.isGlobalScope());
  // TASK-331 #1 — gate tenant-scoped admin pages until a global-scope admin
  // selects a tenant (header ScopeSwitcher → `setTenant`).
  const tenantSelected = useAuthStore((s) => !!s.tenantId);
  const { order, reorder } = useAdminPreferences();

  const adminItems = useMemo(
    () => buildAdminNavItems({ isAdmin, isGlobalScope, tenantSelected, order }),
    [isAdmin, isGlobalScope, tenantSelected, order],
  );

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-md">
            <Zap className="size-4" />
          </div>
          <div className="grid text-left text-sm leading-tight">
            <span className="truncate font-semibold">ArcaVox</span>
            <span className="text-muted-foreground truncate text-xs">Admin Console</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <DraggableNavGroup label="Administration" items={adminItems} onReorder={reorder} />
        <NavGroup label="Playground" items={playgroundItems} />
        <NavGroup label="Documents" items={documentItems} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
