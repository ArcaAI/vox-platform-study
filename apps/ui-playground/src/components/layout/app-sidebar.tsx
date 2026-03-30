import { useAuthStore } from '@/store/auth-store';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarRail } from '@arcaai/ui/sidebar';
import {
  BookOpen,
  Brain,
  Building2,
  Dna,
  Download,
  FileText,
  HardDrive,
  Headphones,
  Hospital,
  LayoutDashboard,
  MessageSquare,
  ScrollText,
  Settings,
  Settings2,
  Users,
  Workflow,
  Zap,
} from 'lucide-react';
import { useMemo } from 'react';
import { NavGroup, type NavItem } from './nav-group';
import { NavUser } from './nav-user';

const gettingStartedItems: NavItem[] = [
  {
    title: 'Introduction',
    url: '/',
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
  const isSuperAdmin = useAuthStore((s: { isSuperAdmin: () => boolean }) => s.isSuperAdmin);
  const roles = useAuthStore((s: { user?: { roles?: string[] } | null }) => s.user?.roles ?? []);
  const canAccessDnaReports = roles.includes('SUPER_ADMIN') || roles.includes('GLOBAL_ADMIN') || roles.includes('TENANT_ADMIN');

  const adminItems = useMemo<NavItem[]>(() => {
    const items: NavItem[] = [
      {
        title: 'Overview',
        url: '/admin/overview',
        icon: Settings,
      },
    ];

    if (canAccessDnaReports) {
      items.push({
        title: 'DNA Reports',
        url: '/admin/dna-reports',
        icon: Dna,
        badge: 'NEW',
      });
    }

    if (isSuperAdmin()) {
      items.push(
        {
          title: 'Tenants',
          url: '/admin/tenants',
          icon: Building2,
        },
        {
          title: 'Users',
          url: '/admin/users',
          icon: Users,
        },
        {
          title: 'Prompts',
          url: '/admin/prompts',
          icon: FileText,
          badge: 'NEW',
        },
        {
          title: 'Departments',
          url: '/admin/departments',
          icon: Hospital,
          badge: 'NEW',
        },
        {
          title: 'Audio Pipelines',
          url: '/admin/audio-pipelines',
          icon: Workflow,
          badge: 'NEW',
        },
      );
    }

    if (canAccessDnaReports) {
      items.push(
        {
          title: 'Storage',
          url: '/admin/storage',
          icon: HardDrive,
        },
        {
          title: 'Configurations',
          url: '/admin/configurations',
          icon: Settings2,
        },
        {
          title: 'Audit Logs',
          url: '/admin/audit-logs',
          icon: ScrollText,
        },
      );
    }

    return items;
  }, [canAccessDnaReports, isSuperAdmin]);

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-md">
            <Zap className="size-4" />
          </div>
          <div className="grid text-left text-sm leading-tight">
            <span className="truncate font-semibold">ArcaVox</span>
            <span className="text-muted-foreground truncate text-xs">Playground</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavGroup label="Getting Started" items={gettingStartedItems} />
        <NavGroup label="Playground" items={playgroundItems} />
        <NavGroup label="Administration" items={adminItems} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
