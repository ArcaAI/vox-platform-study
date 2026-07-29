'use client';

import { IconTrash } from '@tabler/icons-react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useIdentityProvider } from '../api/hooks';
import type { IdpStatus, TenantIdpConfig } from '../api/types';
import { DirectorySyncPanel } from './directory-sync-panel';
import { CreateProviderForm, EditProviderForm } from './identity-provider-form';

type ProviderTab = 'overview' | 'directory';

const PROVIDER_TABS = ['overview', 'directory'] as const;

const TAB_DEFS: { value: ProviderTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'directory', label: 'Directory sync' },
];

const STATUS_BADGE: Record<IdpStatus, { label: string; variant: 'outline' | 'secondary' | 'destructive' }> = {
  DRAFT: { label: 'Draft', variant: 'outline' },
  ENABLED: { label: 'Enabled', variant: 'secondary' },
  DISABLED: { label: 'Disabled', variant: 'destructive' },
};

function useProviderTab() {
  return useQueryState('ptab', parseAsStringLiteral(PROVIDER_TABS).withDefault('overview'));
}

function StatusBadge({ provider }: { provider: TenantIdpConfig }) {
  const badge = STATUS_BADGE[provider.providerStatus];
  return <Badge variant={badge.variant}>{badge.label}</Badge>;
}

function ProviderTabsList() {
  return (
    <TabsList variant="line">
      {TAB_DEFS.map((tab) => (
        <TabsTrigger key={tab.value} value={tab.value}>
          {tab.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

function ProviderMeta({ provider }: { provider: TenantIdpConfig }) {
  return (
    <>
      <span className="font-mono">{provider.id}</span>
      <CopyButton value={provider.id} label="Copy provider id" />
      <span aria-hidden>&middot;</span>
      <span>{provider.protocol}</span>
      <span aria-hidden>&middot;</span>
      <span>{provider.hasSecret ? 'Secret configured' : 'No secret'}</span>
      {provider.updatedAt ? (
        <>
          <span aria-hidden>&middot;</span>
          <span>Updated {formatDateTime(provider.updatedAt)}</span>
        </>
      ) : null}
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/**
 * Console-wide record detail for Identity Providers — a right
 * slide-over (full-screen sheet on mobile). Overview (OIDC config edit + test
 * connection) · Directory sync (credentials + admin-triggered pull) tabs;
 * create mode reuses the same surface with a single create form.
 */
export function IdentityProviderDetailDrawer({
  providerId,
  creating,
  onOpenChange,
  onCreated,
  onRequestDelete,
}: {
  providerId: string | null;
  creating: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (provider: TenantIdpConfig) => void;
  onRequestDelete: (provider: TenantIdpConfig) => void;
}) {
  const open = creating || providerId !== null;
  const [tab, setTab] = useProviderTab();
  const detail = useIdentityProvider(providerId ?? '');
  const provider = providerId ? (detail.data?.data ?? null) : null;
  const etag = detail.data?.etag ?? null;

  if (creating) {
    return (
      <DetailDrawer open={open} onOpenChange={onOpenChange} size="lg" title="New identity provider">
        <CreateProviderForm onCreated={onCreated} onCancel={() => onOpenChange(false)} />
      </DetailDrawer>
    );
  }

  return (
    <Tabs value={tab} onValueChange={(next) => void setTab(next as ProviderTab)}>
      <DetailDrawer
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={provider ? provider.displayName : 'Identity provider'}
        badges={provider ? <StatusBadge provider={provider} /> : null}
        meta={provider ? <ProviderMeta provider={provider} /> : null}
        tabs={provider ? <ProviderTabsList /> : null}
        footer={
          provider ? (
            <Button variant="destructive" size="sm" onClick={() => onRequestDelete(provider)}>
              <IconTrash aria-hidden />
              Delete
            </Button>
          ) : null
        }
      >
        {!open ? null : detail.isPending ? (
          <DetailSkeleton />
        ) : detail.error || !provider ? (
          <ErrorState
            error={detail.error ?? new GatewayError(404, 'This identity provider does not exist or is outside your access scope.')}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <>
            <TabsContent value="overview" className="mt-0 flex min-h-0 flex-1 flex-col">
              <EditProviderForm
                key={`${provider.id}-${provider.updatedAt}`}
                provider={provider}
                etag={etag}
                onSaved={() => void detail.refetch()}
                onReload={() => void detail.refetch()}
              />
            </TabsContent>
            <TabsContent value="directory" className="mt-0">
              <DirectorySyncPanel provider={provider} etag={etag} onSaved={() => void detail.refetch()} />
            </TabsContent>
          </>
        )}
      </DetailDrawer>
    </Tabs>
  );
}
