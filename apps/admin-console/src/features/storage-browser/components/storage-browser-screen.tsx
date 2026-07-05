'use client';

import { useState } from 'react';
import { IconUpload } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { FilterBar, FilterSearch, FilterSelect } from '@/shared/data/filter-bar';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useBuckets, useObjects } from '../api/hooks';
import type { StorageObject } from '../api/types';
import { BucketListCard } from './bucket-list-card';
import { ObjectActionsPanel, UPLOAD_INPUT_ID } from './object-actions-panel';
import { deriveEntries, ObjectBrowserPanel, sortEntries, type FileEntry } from './object-browser-panel';

const ENDPOINT_HINT = 'GET /storage/buckets';

function ScreenBody() {
    const bucketsQuery = useBuckets();
    const [{ bucket: bucketParam, prefix, search, page, limit, sort }, setParams] = useQueryStates({
        bucket: parseAsString.withDefault(''),
        prefix: parseAsString.withDefault(''),
        search: parseAsString.withDefault(''),
        page: parseAsInteger.withDefault(0),
        limit: parseAsInteger.withDefault(25),
        sort: parseAsString.withDefault('key:asc'),
    });
    const [selectedKey, setSelectedKey] = useState<string | null>(null);

    const buckets = bucketsQuery.data ?? [];
    // The URL param wins when it names a real bucket; otherwise the first one.
    const activeBucket = buckets.some((candidate) => candidate.name === bucketParam) ? bucketParam : (buckets[0]?.name ?? '');

    const objectsQuery = useObjects(activeBucket, prefix || undefined);
    const objects = objectsQuery.data ?? [];

    const needle = search.toLowerCase();
    const entries = deriveEntries(objects, prefix).filter((entry) => {
        if (!needle) return true;
        return entry.kind === 'file' ? entry.key.toLowerCase().includes(needle) : entry.name.toLowerCase().includes(needle);
    });
    const sorted = sortEntries(entries, sort);
    const pageRows = sorted.slice(page * limit, (page + 1) * limit);

    const selectedEntry = sorted.find((entry): entry is FileEntry => entry.kind === 'file' && entry.key === selectedKey);
    const selectedObject: StorageObject | null = selectedEntry
        ? { key: selectedEntry.key, size: selectedEntry.size, lastModified: selectedEntry.lastModified }
        : null;

    function selectBucket(name: string) {
        setSelectedKey(null);
        void setParams({ bucket: name === buckets[0]?.name ? null : name, prefix: null, page: null });
    }

    function navigatePrefix(nextPrefix: string) {
        setSelectedKey(null);
        void setParams({ prefix: nextPrefix || null, page: null });
    }

    function focusUploadZone() {
        document.getElementById(UPLOAD_INPUT_ID)?.focus();
    }

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Storage"
                meta={
                    <>
                        {bucketsQuery.data && !objectsQuery.isPending ? (
                            <span>
                                {formatNumber(buckets.length)} {buckets.length === 1 ? 'bucket' : 'buckets'} {'\u00b7'}{' '}
                                {formatNumber(objects.length)} {objects.length === 1 ? 'object' : 'objects'}
                            </span>
                        ) : (
                            <Skeleton className="h-4 w-40" />
                        )}
                        <span aria-hidden className="text-muted-foreground font-mono text-xs">
                            {ENDPOINT_HINT}
                        </span>
                        <span>tenant-scoped listing only</span>
                    </>
                }
                actions={
                    <Button onClick={focusUploadZone}>
                        <IconUpload aria-hidden />
                        Upload files
                    </Button>
                }
            />
            <FilterBar shown={pageRows.length} total={entries.length}>
                <FilterSearch
                    label="Search objects"
                    placeholder={'Search objects (prefix)\u2026'}
                    value={search}
                    onChange={(value) => void setParams({ search: value || null, page: null })}
                />
                {/* value is always a real bucket name once the list loads, so the
                    "All" sentinel row only shows while buckets are empty. */}
                <FilterSelect
                    id="storage-browser-bucket-filter"
                    label="Bucket"
                    value={activeBucket}
                    onChange={selectBucket}
                    options={buckets.map((candidate) => ({ value: candidate.name, label: candidate.name }))}
                />
                <span aria-hidden className="text-muted-foreground ml-auto hidden font-mono text-xs lg:inline">
                    GET buckets/:name/files
                </span>
            </FilterBar>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)_18rem]">
                <BucketListCard buckets={buckets} isLoading={bucketsQuery.isPending} activeBucket={activeBucket} onSelect={selectBucket} />
                <ObjectBrowserPanel
                    bucketName={activeBucket}
                    prefix={prefix}
                    onNavigate={navigatePrefix}
                    rows={pageRows}
                    total={entries.length}
                    isLoading={bucketsQuery.isPending || (!!activeBucket && objectsQuery.isPending)}
                    error={bucketsQuery.error ?? objectsQuery.error}
                    onRetry={() => {
                        if (bucketsQuery.error) void bucketsQuery.refetch();
                        if (objectsQuery.error) void objectsQuery.refetch();
                    }}
                    sort={sort}
                    onSortChange={(next) => void setParams({ sort: next === 'key:asc' ? null : next })}
                    page={page}
                    limit={limit}
                    onPageChange={(next) => void setParams({ page: next === 0 ? null : next })}
                    onLimitChange={(next) => void setParams({ limit: next === 25 ? null : next, page: null })}
                    selectedKey={selectedKey}
                    onSelectFile={setSelectedKey}
                    hasSearch={!!search}
                    onClearSearch={() => void setParams({ search: null, page: null })}
                    onRequestUpload={focusUploadZone}
                />
                <ObjectActionsPanel bucketName={activeBucket} object={selectedObject} onDeleted={() => setSelectedKey(null)} />
            </div>
        </div>
    );
}

/**
 * Frame 31 — tenant Storage browser (tier 30–49 DATA plane, /storage/*):
 * physical buckets by name, prefix object browsing, presigned downloads,
 * multipart uploads. Distinct from the tier-14 admin plane at
 * /tenants/storage (frame 14).
 */
export function StorageBrowserScreen() {
    return (
        <WorkingTenantGate
            title="Storage"
            meta={
                <span aria-hidden className="text-muted-foreground font-mono text-xs">
                    {ENDPOINT_HINT}
                </span>
            }
            description="Storage is browsed per tenant. Pick a working tenant from the switcher in the top bar to list its buckets and objects."
        >
            <ScreenBody />
        </WorkingTenantGate>
    );
}
