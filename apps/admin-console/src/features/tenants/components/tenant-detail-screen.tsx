'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { IconArchive, IconArrowLeft, IconPlayerPause, IconRestore, IconTrash } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { formatDateTime, formatRelativeTime } from '@/shared/format';
import { useTrailingBreadcrumb } from '@/shared/navigation/breadcrumb-store';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useTenant } from '../api/hooks';
import type { Tenant } from '../api/types';
import { TenantPlanBadge } from './plan-badge';
import { ResyncPipelineTemplatesAction } from './resync-pipeline-templates-action';
import { TenantConfigsTab } from './tenant-configs-tab';
import { TenantFrontendConfigTab } from './tenant-frontend-config-tab';
import { TenantLifecycleDialogs, type LifecycleRequest } from './tenant-lifecycle-dialogs';
import { TenantTagsTab } from './tenant-tags-tab';
import { TenantUsageTab } from './tenant-usage-tab';

const TAB_VALUES = ['overview', 'usage', 'configs', 'tags', 'frontend-config'] as const;

/** Route-level loading.tsx mirrors this shape (rule 10). */
export function TenantDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
      <Skeleton className="h-9 w-96" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function OverviewFact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'flex flex-col gap-1 sm:col-span-2' : 'flex flex-col gap-1'}>
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="flex items-center gap-1 text-sm">{children}</dd>
    </div>
  );
}

function OverviewTab({ tenant }: { tenant: Tenant }) {
  return (
    <Card className="p-6">
      <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <OverviewFact label="Tenant ID">
          <span className="truncate font-mono text-xs">{tenant.id}</span>
          <CopyButton value={tenant.id} label="Copy tenant ID" />
        </OverviewFact>
        <OverviewFact label="Key">
          <span className="font-mono text-xs">{tenant.key}</span>
          <CopyButton value={tenant.key} label="Copy tenant key" />
        </OverviewFact>
        <OverviewFact label="Plan">
          <TenantPlanBadge plan={tenant.plan} />
        </OverviewFact>
        <OverviewFact label="Status">
          <ResourceStatusBadge status={tenant.resourceStatus} />
        </OverviewFact>
        <OverviewFact label="Created">{formatDateTime(tenant.createdAt)}</OverviewFact>
        <OverviewFact label="Updated">
          {formatDateTime(tenant.updatedAt)}
          <span className="text-muted-foreground">({formatRelativeTime(tenant.updatedAt)})</span>
        </OverviewFact>
        <OverviewFact label="Version">
          <span className="font-mono text-xs">v{tenant.version}</span>
        </OverviewFact>
        <OverviewFact label="Description" wide>
          {tenant.description ? <span>{tenant.description}</span> : <span className="text-muted-foreground">{'\u2014'}</span>}
        </OverviewFact>
      </dl>
    </Card>
  );
}

/** Frame 12.1 — Tenant detail: header + lifecycle actions + URL-synced tabs. */
export function TenantDetailScreen({ id }: { id: string }) {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useTenant(id);
  const tenant = data?.data;
  useTrailingBreadcrumb(tenant?.name);
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('overview'));
  const [lifecycle, setLifecycle] = useState<LifecycleRequest | null>(null);

  if (isLoading) {
    return <TenantDetailSkeleton />;
  }
  if (error instanceof GatewayError && error.isNotFound) {
    // 404-over-403 posture: cross-tenant and missing look identical.
    return (
      <div className="flex flex-col gap-4">
        <ErrorState title="Tenant not found" error={new Error('It may not exist or you may not have access.')} />
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => router.push('/tenants')}>
            <IconArrowLeft aria-hidden />
            Back to tenants
          </Button>
        </div>
      </div>
    );
  }
  if (error || !tenant) {
    return <ErrorState error={error ?? new Error('The tenant could not be loaded.')} onRetry={() => refetch()} />;
  }

  const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'overview';
  const status = tenant.resourceStatus;

  return (
    <Tabs value={tab} onValueChange={(next) => setTabParam(next === 'overview' ? null : next)} className="flex min-h-0 flex-1 flex-col">
      <ScreenTemplate
        header={
          <PageHeader
            title={tenant.name}
            meta={
              <>
                <span className="flex items-center gap-1">
                  <span className="font-mono text-xs">{tenant.key}</span>
                  <CopyButton value={tenant.key} label="Copy tenant key" />
                </span>
                <TenantPlanBadge plan={tenant.plan} />
                <ResourceStatusBadge status={status} />
                <span>created {formatDateTime(tenant.createdAt, 'date')}</span>
                <span>updated {formatRelativeTime(tenant.updatedAt)}</span>
              </>
            }
            actions={
              <>
                {status === 'ENABLED' ? (
                  <Button variant="outline" onClick={() => setLifecycle({ action: 'suspend', tenant })}>
                    <IconPlayerPause aria-hidden />
                    Suspend
                  </Button>
                ) : null}
                {status === 'SUSPENDED' || status === 'ARCHIVED' ? (
                  <Button variant="outline" onClick={() => setLifecycle({ action: 'restore', tenant })}>
                    <IconRestore aria-hidden />
                    Restore
                  </Button>
                ) : null}
                {status !== 'ARCHIVED' ? (
                  <Button variant="outline" onClick={() => setLifecycle({ action: 'archive', tenant })}>
                    <IconArchive aria-hidden />
                    Archive
                  </Button>
                ) : null}
                {/* Reconcile this tenant's pipeline
                                    catalog against the SYSTEM templates. */}
                <ResyncPipelineTemplatesAction tenant={tenant} />
                <Button variant="destructive" onClick={() => setLifecycle({ action: 'delete', tenant })}>
                  <IconTrash aria-hidden />
                  Delete
                </Button>
              </>
            }
          />
        }
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="usage">Usage</TabsTrigger>
            <TabsTrigger value="configs">Configs</TabsTrigger>
            <TabsTrigger value="tags">Tags</TabsTrigger>
            <TabsTrigger value="frontend-config">Frontend config</TabsTrigger>
          </TabsList>
        }
        footer={
          <StatusFooter
            start={<ResourceStatusBadge status={status} />}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/tenants/{tenant.id}
              </span>
            }
          />
        }
      >
        <TabsContent value="overview">
          <OverviewTab tenant={tenant} />
        </TabsContent>
        <TabsContent value="usage">
          <TenantUsageTab id={id} />
        </TabsContent>
        <TabsContent value="configs">
          <TenantConfigsTab id={id} />
        </TabsContent>
        <TabsContent value="tags">
          <TenantTagsTab id={id} />
        </TabsContent>
        <TabsContent value="frontend-config">
          <TenantFrontendConfigTab tenantId={id} />
        </TabsContent>
      </ScreenTemplate>
      <TenantLifecycleDialogs request={lifecycle} onOpenChange={(open) => !open && setLifecycle(null)} onDeleted={() => router.push('/tenants')} />
    </Tabs>
  );
}
