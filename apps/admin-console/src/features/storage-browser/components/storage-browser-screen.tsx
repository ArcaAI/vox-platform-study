'use client';

import { IconUpload } from '@tabler/icons-react';
import { parseAsString, useQueryStates } from 'nuqs';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useSession } from '@/shared/auth';
import { FilterSearch } from '@/shared/data/filter-bar';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { useBuckets, useObjects } from '../api/hooks';
import type { StorageObject } from '../api/types';
import { AllTenantsBody } from './all-tenants-panel';
import { ENDPOINT_HINT, HealthStatus } from './health-status';
import { UPLOAD_INPUT_ID, UploadZone } from './object-actions-panel';
import { deriveEntries, ObjectBrowserPanel, PrefixChips, sortEntries } from './object-browser-panel';
import { ObjectDetailDrawer } from './object-detail';

function ScreenBody() {
  const bucketsQuery = useBuckets();
  const [{ bucket: bucketParam, prefix, search, object: objectParam }, setParams] = useQueryStates({
    bucket: parseAsString.withDefault(''),
    prefix: parseAsString.withDefault(''),
    search: parseAsString.withDefault(''),
    object: parseAsString.withDefault(''),
  });

  const buckets = bucketsQuery.data ?? [];
  // The URL param wins when it names a real bucket; otherwise the first one.
  const activeBucket = buckets.some((candidate) => candidate.name === bucketParam) ? bucketParam : (buckets[0]?.name ?? '');

  const objectsQuery = useObjects(activeBucket, prefix || undefined);
  const objects = objectsQuery.data ?? [];

  const needle = search.toLowerCase();
  const allEntries = deriveEntries(objects, prefix);
  const entries = allEntries.filter((entry) => {
    if (!needle) return true;
    return entry.kind === 'file' ? entry.key.toLowerCase().includes(needle) : entry.name.toLowerCase().includes(needle);
  });
  // Folders-first, name-ascending; the embedded grid owns further sort + pagination client-side.
  const sorted = sortEntries(entries, 'key:asc');

  // The `?object=` deep-link (and file-row selection) resolves against the raw
  // listing so a valid key opens the drawer even before the grid renders.
  const selectedObject: StorageObject | null = objectParam ? (objects.find((candidate) => candidate.key === objectParam) ?? null) : null;

  function selectBucket(name: string) {
    void setParams({ bucket: name === buckets[0]?.name ? null : name, prefix: null, object: null });
  }

  function navigatePrefix(nextPrefix: string) {
    void setParams({ prefix: nextPrefix || null, object: null });
  }

  function selectFile(key: string) {
    void setParams({ object: key || null });
  }

  function openUploadPicker() {
    document.getElementById(UPLOAD_INPUT_ID)?.click();
  }

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="Storage"
            meta={
              <>
                {bucketsQuery.data && !objectsQuery.isPending ? (
                  <span>
                    {formatNumber(buckets.length)} {buckets.length === 1 ? 'bucket' : 'buckets'} {'·'} {formatNumber(objects.length)}{' '}
                    {objects.length === 1 ? 'object' : 'objects'}
                  </span>
                ) : (
                  <Skeleton className="h-4 w-40" />
                )}
                <span>tenant-scoped listing only</span>
              </>
            }
            actions={
              <Button onClick={openUploadPicker} disabled={!activeBucket}>
                <IconUpload aria-hidden />
                Upload files
              </Button>
            }
          />
        }
        toolbar={
          <div className="flex flex-col gap-3">
            <div className="bg-card flex flex-wrap items-end gap-3 rounded-md border p-2">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="storage-browser-bucket" className="text-muted-foreground text-sm font-normal">
                  Bucket:
                </Label>
                <Select value={activeBucket} onValueChange={selectBucket}>
                  <SelectTrigger id="storage-browser-bucket" size="sm" className="min-w-48">
                    <SelectValue placeholder="Select bucket" />
                  </SelectTrigger>
                  <SelectContent>
                    {buckets.map((candidate) => (
                      <SelectItem key={candidate.name} value={candidate.name}>
                        {candidate.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <FilterSearch
                label="Search objects"
                placeholder={'Search objects (prefix)…'}
                value={search}
                onChange={(value) => void setParams({ search: value || null })}
              />
              <span aria-hidden className="text-muted-foreground ml-auto hidden font-mono text-xs lg:inline">
                GET buckets/:name/files
              </span>
            </div>
            {activeBucket ? <PrefixChips bucketName={activeBucket} prefix={prefix} onNavigate={navigatePrefix} /> : null}
          </div>
        }
        footer={
          <StatusFooter
            start={
              <>
                <HealthStatus />
                <span>{objectsQuery.isFetching && !objectsQuery.isLoading ? 'Refreshing' : 'Up to date'}</span>
              </>
            }
            end={
              <span aria-hidden className="font-mono">
                {ENDPOINT_HINT}
              </span>
            }
          />
        }
      >
        <ObjectBrowserPanel
          onNavigate={navigatePrefix}
          rows={sorted}
          isLoading={bucketsQuery.isPending || (!!activeBucket && objectsQuery.isPending)}
          error={bucketsQuery.error ?? objectsQuery.error}
          onRetry={() => {
            if (bucketsQuery.error) void bucketsQuery.refetch();
            if (objectsQuery.error) void objectsQuery.refetch();
          }}
          selectedKey={selectedObject?.key ?? null}
          onSelectFile={selectFile}
          hasSearch={!!search}
          onClearSearch={() => void setParams({ search: null })}
          onRequestUpload={openUploadPicker}
        />
      </ScreenTemplate>
      {activeBucket ? <UploadZone key={activeBucket} bucketName={activeBucket} /> : null}

      <ObjectDetailDrawer
        bucketName={activeBucket}
        object={selectedObject}
        onOpenChange={(open) => {
          if (!open) void setParams({ object: null });
        }}
        onDeleted={() => void setParams({ object: null })}
      />
    </>
  );
}

/**
 * Frame 31 — tenant Storage browser (tier 30–49 DATA plane, /storage/*):
 * physical buckets by name, prefix object browsing, presigned downloads,
 * multipart uploads. Distinct from the tier-14 admin plane at
 * /tenants/storage (frame 14). Redesign (build spec: fill-height object
 * grid + breadcrumb path bar, bucket select in the toolbar, object actions in
 * the console-wide detail slide-over.
 *
 * TASK-932 Lane T: an elevated session with NO working tenant no longer hits
 * the NoTenant gate — it gets the "All tenants" cross-tenant + physical-bucket
 * view (`AllTenantsBody`) instead. Elevated + a working tenant selected, and a
 * tenant admin, are both unchanged (`ScreenBody`, tenant-scoped).
 */
export function StorageBrowserScreen() {
  const session = useSession();

  if (!session.data) {
    // m5 — the session decides which of the two bodies below to render (all
    // tenants vs. one), so nothing beyond the header is known yet. That is a
    // ScreenTemplate loading state like any other (`ai-providers-screen.tsx`'s
    // own `scope.isLoading` branch), not a reason to hand-roll the page frame.
    return (
      <ScreenTemplate header={<PageHeader title="Storage" meta={<Skeleton className="h-4 w-40" />} />}>
        <Skeleton className="h-64 w-full" />
      </ScreenTemplate>
    );
  }

  if (session.data.effectiveIsElevated && !session.data.effectiveTenantId) {
    return <AllTenantsBody />;
  }

  return <ScreenBody />;
}
