import { DebugToggle } from '@/components/debug-toggle';
import { ThemeSwitch } from '@/components/theme-switch';
import { useTenant } from '@/features/admin/api/tenants';
import { DocToggleButton } from '@/features/doc-panel';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { Badge } from '@arcaai/ui/badge';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@arcaai/ui/breadcrumb';
import { Separator } from '@arcaai/ui/separator';
import { SidebarTrigger } from '@arcaai/ui/sidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui/tooltip';
import { useAuth } from '@arcaai/vox';
import { Link, useMatches } from '@tanstack/react-router';
import { Building2, UserCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

const routeMeta: Record<string, { label: string; parent?: { label: string; path: string } }> = {
  '/_authenticated/': { label: 'Home' },
  '/_authenticated/installation/': {
    label: 'Installation',
  },
  '/_authenticated/installation/room': {
    label: '@arcaai/room',
    parent: { label: 'Installation', path: '/installation' },
  },
  '/_authenticated/installation/stt': {
    label: '@arcaai/stt',
    parent: { label: 'Installation', path: '/installation' },
  },
  '/_authenticated/installation/vad': {
    label: '@arcaai/vad',
    parent: { label: 'Installation', path: '/installation' },
  },
  '/_authenticated/installation/noise-filter': {
    label: '@arcaai/noise-filter',
    parent: { label: 'Installation', path: '/installation' },
  },
  '/_authenticated/playground/overview': {
    label: 'Overview',
    parent: { label: 'Playground', path: '/playground/overview' },
  },
  '/_authenticated/consultation/': {
    label: 'Consultation',
    parent: { label: 'Playground', path: '/playground/overview' },
  },
  '/_authenticated/audio/live-transcription': {
    label: 'Live Transcription',
    parent: { label: 'Playground', path: '/playground/overview' },
  },
  '/_authenticated/consultation/$id': {
    label: 'Consultation Detail',
    parent: { label: 'Consultation', path: '/consultation' },
  },
  '/_authenticated/summarization/pre-summary': {
    label: 'Pre-Summary',
    parent: { label: 'Playground', path: '/playground/overview' },
  },
  '/_authenticated/summarization/summary': {
    label: 'Summary',
    parent: { label: 'Playground', path: '/playground/overview' },
  },
  '/_authenticated/dna-writing-style/': {
    label: 'DNA Writing Style',
    parent: { label: 'Playground', path: '/playground/overview' },
  },
  '/_authenticated/audio/job-transcription': {
    label: 'Job Transcription',
    parent: { label: 'Audio & Transcription', path: '/audio/live-transcription' },
  },
  '/_authenticated/admin/overview': {
    label: 'Overview',
    parent: { label: 'Administration', path: '/admin/overview' },
  },
  '/_authenticated/admin/tenants': {
    label: 'Tenants',
    parent: { label: 'Administration', path: '/admin/overview' },
  },
  '/_authenticated/admin/users': {
    label: 'Users',
    parent: { label: 'Administration', path: '/admin/overview' },
  },
  '/_authenticated/admin/prompts': {
    label: 'Prompts',
    parent: { label: 'Administration', path: '/admin/overview' },
  },
  '/_authenticated/admin/departments': {
    label: 'Departments',
    parent: { label: 'Administration', path: '/admin/overview' },
  },
  '/_authenticated/admin/dna-reports': {
    label: 'DNA Reports',
    parent: { label: 'Administration', path: '/admin/overview' },
  },
};

interface HeaderProps extends React.HTMLAttributes<HTMLElement> {
  fixed?: boolean;
}

export function Header({ className, fixed, ...props }: HeaderProps) {
  const [offset, setOffset] = useState(0);

  let sdkAuth: ReturnType<typeof useAuth> | null = null;
  try {
    sdkAuth = useAuth();
  } catch {
    /* SDK not ready */
  }

  const persistedImpersonating = useAuthStore((s) => s.isImpersonating);
  const persistedImpersonatedUser = useAuthStore((s) => s.impersonatedUser);
  const isImpersonating = sdkAuth?.isImpersonating || persistedImpersonating;
  const impersonatedUser = sdkAuth?.impersonatedUser ?? persistedImpersonatedUser;

  const tenantId = useAuthStore((s) => s.tenantId);
  const tenantKey = useAuthStore((s) => s.tenantKey);
  const tenantName = useAuthStore((s) => s.tenantName);
  const setTenant = useAuthStore((s) => s.setTenant);
  const matches = useMatches();

  const needsFetch = !!tenantId && !tenantName;
  const { data: tenantData } = useTenant(tenantId, { enabled: needsFetch, staleTime: 5 * 60 * 1000, retry: 1 });

  useEffect(() => {
    if (tenantData?.name && !tenantName) {
      setTenant(tenantId, tenantData.name);
    }
  }, [tenantData, tenantId, tenantName, setTenant]);

  useEffect(() => {
    const onScroll = () => {
      setOffset(document.body.scrollTop || document.documentElement.scrollTop);
    };
    document.addEventListener('scroll', onScroll, { passive: true });
    return () => document.removeEventListener('scroll', onScroll);
  }, []);

  const currentMatch = matches[matches.length - 1];
  const meta = currentMatch ? routeMeta[currentMatch.routeId] : undefined;

  return (
    <header
      className={cn(
        'z-50 h-16',
        fixed && 'header-fixed peer/header sticky top-0 w-[inherit]',
        offset > 10 && fixed ? 'shadow' : 'shadow-none',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          'relative flex h-full items-center gap-3 p-4 sm:gap-4',
          offset > 10 && fixed && 'after:bg-background/20 after:absolute after:inset-0 after:-z-10 after:backdrop-blur-lg',
        )}
      >
        <SidebarTrigger variant="outline" className="max-md:scale-125" />
        <Separator orientation="vertical" className="h-6" />

        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="flex-nowrap">
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/">Home</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            {meta?.parent && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link to={meta.parent.path}>{meta.parent.label}</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
              </>
            )}
            {meta && meta.label !== 'Home' && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="truncate max-w-[200px]">{meta.label}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>

        <div className="ms-auto flex shrink-0 items-center gap-3">
          {tenantId &&
            (() => {
              const displayName = tenantName || tenantKey || tenantData?.key || tenantId.slice(0, 8) + '\u2026';
              const resolvedKey = tenantKey || tenantData?.key;
              return (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="cursor-default gap-1.5">
                        <Building2 className="size-3.5" />
                        {displayName}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="end">
                      <div className="flex flex-col gap-1 text-xs">
                        {tenantName && (
                          <>
                            <span className="text-muted-foreground">Name</span>
                            <span className="font-medium">{tenantName}</span>
                          </>
                        )}
                        {resolvedKey && (
                          <>
                            <span className="text-muted-foreground mt-1">Key</span>
                            <span className="font-mono">{resolvedKey}</span>
                          </>
                        )}
                        <span className="text-muted-foreground mt-1">ID</span>
                        <span className="font-mono">{tenantId}</span>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            })()}
          {isImpersonating && (
            <Badge variant="destructive" className="gap-1.5">
              <UserCheck className="size-3.5" />
              Impersonating: {impersonatedUser?.username || 'Unknown'}
            </Badge>
          )}
          <DebugToggle />
          <DocToggleButton />
          <ThemeSwitch />
        </div>
      </div>
    </header>
  );
}
