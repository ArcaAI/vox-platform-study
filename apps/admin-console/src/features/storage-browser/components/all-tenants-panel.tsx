'use client';

import { useCallback, useMemo } from 'react';
import Link from 'next/link';
import { IconArrowLeft, IconBuilding, IconExternalLink, IconFilterOff } from '@tabler/icons-react';
import { parseAsString, useQueryStates } from 'nuqs';
import { VirtualizedDataGrid, type ColumnDef } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { FilterSearch } from '@/shared/data/filter-bar';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useBucketsAllTenants, useObjects } from '../api/hooks';
import type { StorageBucketWithScope } from '../api/types';
import { ENDPOINT_HINT, HealthStatus } from './health-status';
import { deriveEntries, ObjectBrowserPanel, PrefixChips, sortEntries } from './object-browser-panel';

/** Stable parser identities (module scope, not recreated per render) for the nuqs URL state below. */
const QUERY_PARSERS = {
  bucket: parseAsString.withDefault(''),
  prefix: parseAsString.withDefault(''),
  search: parseAsString.withDefault(''),
};

/**
 * Passive info banner (TASK-932): the "All tenants" scope note. No working
 * tenant is selected, so there is nothing to name in an "Acting on" banner —
 * this instead explains what the wider listing is and that it is read-only.
 */
function AllTenantsBanner() {
  return (
    <div role="status" className="bg-info/10 text-foreground flex items-center gap-2 rounded-md px-4 py-1.5 text-sm">
      <IconBuilding aria-hidden className="text-info size-4 shrink-0" />
      <span className="min-w-0 truncate">
        Viewing <span className="font-medium">all tenants</span> — registered and physical MinIO buckets, browse-only. Select a working tenant to
        manage files.
      </span>
    </div>
  );
}

/**
 * A platform bucket is checked FIRST: it is never registered until a platform
 * admin adopts it into System, so the plain `!registered` test below would
 * otherwise label it "Unregistered" and lose the fact that it is platform-owned.
 */
function statusBadge(bucket: StorageBucketWithScope) {
  if (bucket.platform) return <Badge variant="secondary">Platform</Badge>;
  if (!bucket.registered) return <Badge variant="outline">Unregistered</Badge>;
  if (bucket.physicalMissing) return <Badge variant="destructive">Missing physically</Badge>;
  return <Badge variant="secondary">Registered</Badge>;
}

/**
 * The storage browser "All tenants" view (TASK-932 Lane T): an unscoped
 * platform admin (no working tenant) sees every tenant's registered buckets
 * merged with the physical MinIO/S3 bucket list
 * (`GET storage/buckets?includePhysical=true`). A registered bucket opens a
 * read-only object browser (folders navigate; no upload/download/delete —
 * those routes are tenant-bound); an unregistered physical bucket is a
 * read-only row with a plain-href link that carries the bucket name to the
 * tier-14 admin screen (`/tenants/storage?register=<name>`), which opens its
 * adopt dialog prefilled — no cross-feature import. A PLATFORM bucket
 * (`hope-models`, `mlflow`, the claim check, backups) is browsable AND
 * registerable to the System tenant (TASK-967); its adopt dialog locks the
 * owner to System, because a platform bucket is never owned by a customer.
 */
export function AllTenantsBody() {
  const bucketsQuery = useBucketsAllTenants(true);
  const [{ bucket: bucketParam, prefix, search }, setParams] = useQueryStates(QUERY_PARSERS);

  const buckets = bucketsQuery.data ?? [];
  // TASK-967 — keyed on the NAME alone. A platform bucket is never registered,
  // so requiring `registered` here silently ignored even a hand-typed
  // `?bucket=hope-models`, and the gateway has always served it
  // (`GET storage/buckets/:name/files` carries `scope: 'super-admin'`).
  const browsingBucket = bucketParam ? (buckets.find((candidate) => candidate.name === bucketParam) ?? null) : null;

  const objectsQuery = useObjects(browsingBucket?.name ?? '', prefix || undefined);
  const objects = objectsQuery.data ?? [];
  const entries = sortEntries(deriveEntries(objects, prefix), 'key:asc');

  const tenantCount = new Set(buckets.filter((bucket) => bucket.tenantId).map((bucket) => bucket.tenantId)).size;

  const openBucket = useCallback((name: string) => void setParams({ bucket: name, prefix: null }), [setParams]);
  function closeBucket() {
    void setParams({ bucket: null, prefix: null });
  }
  function navigatePrefix(nextPrefix: string) {
    void setParams({ prefix: nextPrefix || null });
  }

  const needle = search.toLowerCase();
  const filteredBuckets = buckets.filter((bucket) => {
    if (!needle) return true;
    return bucket.name.toLowerCase().includes(needle) || (bucket.tenantName ?? '').toLowerCase().includes(needle);
  });

  const columns = useMemo<ColumnDef<StorageBucketWithScope>[]>(
    () => [
      {
        id: 'name',
        header: 'Bucket',
        enableSorting: false,
        meta: { label: 'Bucket' },
        cell: ({ row }) => <span className="font-mono text-xs font-medium">{row.original.name}</span>,
        size: 280,
        minSize: 180,
      },
      {
        id: 'tenant',
        header: 'Tenant',
        enableSorting: false,
        meta: { label: 'Tenant' },
        cell: ({ row }) =>
          row.original.tenantName ? <span>{row.original.tenantName}</span> : <span className="text-muted-foreground">{'—'}</span>,
        size: 200,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        meta: { label: 'Status' },
        cell: ({ row }) => statusBadge(row.original),
        size: 160,
      },
      {
        id: 'created',
        header: 'Created',
        enableSorting: false,
        meta: { label: 'Created' },
        cell: ({ row }) => <span className="text-muted-foreground">{formatRelativeTime(row.original.creationDate)}</span>,
        size: 128,
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        meta: { label: 'Actions' },
        cell: ({ row }) => {
          const bucket = row.original;
          // The bucket name rides along in the query string so the tier-14
          // screen can open its register dialog already filled in — without it
          // the operator lands on a list that does not contain this bucket.
          // `&platform=1` carries the GATEWAY's classification to the adopt
          // dialog, which locks the owner to System. The console never
          // re-derives it: `isPlatformBucket` lives in `@arcaai/domains`, a
          // backend package, and a second copy of the nine names would drift.
          const registerLink = (
            <Link
              href={`/tenants/storage?register=${encodeURIComponent(bucket.name)}${bucket.platform ? '&platform=1' : ''}`}
              className="text-foreground inline-flex items-center gap-1 text-sm underline underline-offset-4"
            >
              Register
              <IconExternalLink aria-hidden className="size-3.5" />
            </Link>
          );
          const browseButton = (
            <Button variant="ghost" size="sm" onClick={() => openBucket(bucket.name)}>
              Browse
            </Button>
          );

          // TASK-967 — a PLATFORM bucket gets BOTH. It is browsable (the
          // gateway already served it) and registerable, to the System tenant,
          // which is what makes it manageable on the tier-14 screen. It used to
          // get no action at all, which left `hope-models` unreachable.
          if (bucket.platform) {
            return (
              <div className="flex items-center gap-1">
                {browseButton}
                {!bucket.registered && registerLink}
              </div>
            );
          }
          if (bucket.registered) return browseButton;
          return registerLink;
        },
        size: 190,
      },
    ],
    [openBucket],
  );

  return (
    <ScreenTemplate
      contentMode="fill"
      header={
        <PageHeader
          title="Storage"
          meta={
            bucketsQuery.data ? (
              <span>
                {formatNumber(buckets.length)} {buckets.length === 1 ? 'bucket' : 'buckets'} {'·'} {formatNumber(tenantCount)}{' '}
                {tenantCount === 1 ? 'tenant' : 'tenants'}
              </span>
            ) : (
              <Skeleton className="h-4 w-40" />
            )
          }
        />
      }
      statusBanner={<AllTenantsBanner />}
      toolbar={
        browsingBucket ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={closeBucket}>
              <IconArrowLeft aria-hidden />
              All buckets
            </Button>
            <PrefixChips bucketName={browsingBucket.name} prefix={prefix} onNavigate={navigatePrefix} />
          </div>
        ) : (
          <div className="bg-card flex flex-wrap items-center gap-3 rounded-md border p-2">
            <FilterSearch
              label="Search buckets"
              placeholder="Search bucket or tenant name…"
              value={search}
              onChange={(value) => void setParams({ search: value || null })}
            />
          </div>
        )
      }
      footer={
        <StatusFooter
          start={
            <>
              <HealthStatus />
              <span>All tenants</span>
            </>
          }
          end={
            <span aria-hidden className="font-mono">
              {ENDPOINT_HINT}?includePhysical=true
            </span>
          }
        />
      }
    >
      {browsingBucket ? (
        <ObjectBrowserPanel
          onNavigate={navigatePrefix}
          rows={entries}
          isLoading={objectsQuery.isPending}
          error={objectsQuery.error}
          onRetry={() => void objectsQuery.refetch()}
          selectedKey={null}
          onSelectFile={() => {}}
          hasSearch={false}
          onClearSearch={() => {}}
          readOnly
        />
      ) : (
        <VirtualizedDataGrid<StorageBucketWithScope>
          aria-label="Storage buckets across all tenants"
          columns={columns}
          data={filteredBuckets}
          getRowId={(row) => row.name}
          toolbar={false}
          features={{
            globalSearch: false,
            facetedFilters: false,
            sorting: false,
            rowSelection: false,
            columnReorder: false,
            columnResize: false,
            columnPinning: false,
            columnVisibility: false,
          }}
          isLoading={bucketsQuery.isPending}
          error={bucketsQuery.error instanceof Error ? bucketsQuery.error : null}
          errorState={(err) => <ErrorState error={err} onRetry={() => void bucketsQuery.refetch()} />}
          // `VirtualizedDataGrid` takes only ONE empty-state node (no separate
          // "no rows at all" vs "no rows after filtering" prop, unlike
          // `AdminDataGrid`), so the distinction is made HERE: a search that
          // matches nothing is a different fact from no bucket existing at all,
          // and "No buckets yet" was misleading whenever a search was active (m4).
          emptyState={
            buckets.length > 0 && filteredBuckets.length === 0 ? (
              <EmptyState
                icon={IconFilterOff}
                title="No buckets match this search"
                description="Clear the search to see the rest of the buckets."
                action={
                  <Button variant="outline" onClick={() => void setParams({ search: null })}>
                    <IconFilterOff aria-hidden />
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState icon={IconBuilding} title="No buckets yet" description="No tenant has a registered bucket, and no physical bucket exists." />
            )
          }
        />
      )}
    </ScreenTemplate>
  );
}
