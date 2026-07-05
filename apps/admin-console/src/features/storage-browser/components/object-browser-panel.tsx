'use client';

import { IconChevronRight, IconCircleDot, IconFilterOff, IconFolder, IconFolderOpen, IconUpload } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { cx } from '@/shared/cx';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatBytes, formatNumber, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import type { StorageObject } from '../api/types';
import { fileTypeIcon } from './file-meta';

export interface FolderEntry {
    kind: 'folder';
    name: string;
    /** Prefix to navigate into (current prefix + name + '/'). */
    prefix: string;
    count: number;
}

export interface FileEntry {
    kind: 'file';
    /** Display name relative to the current prefix. */
    name: string;
    /** Full object key as the gateway lists it. */
    key: string;
    size: number;
    lastModified?: string;
}

export type BrowserEntry = FolderEntry | FileEntry;

/**
 * Groups the flat key listing under the current prefix into folder rows +
 * file rows (the gateway returns keys, not delimiter-based CommonPrefixes).
 */
export function deriveEntries(objects: StorageObject[], prefix: string): BrowserEntry[] {
    const folders = new Map<string, number>();
    const files: FileEntry[] = [];
    for (const object of objects) {
        const rest = object.key.startsWith(prefix) ? object.key.slice(prefix.length) : object.key;
        const slash = rest.indexOf('/');
        if (slash === -1) {
            if (rest) files.push({ kind: 'file', name: rest, key: object.key, size: object.size, lastModified: object.lastModified });
        } else {
            const folder = rest.slice(0, slash);
            folders.set(folder, (folders.get(folder) ?? 0) + 1);
        }
    }
    const folderEntries: FolderEntry[] = [...folders.entries()].map(([name, count]) => ({
        kind: 'folder',
        name,
        prefix: `${prefix}${name}/`,
        count,
    }));
    return [...folderEntries, ...files];
}

/** Client-side sort ("field:asc|desc"): folders always group before files. */
export function sortEntries(entries: BrowserEntry[], sort: string): BrowserEntry[] {
    const [field, direction] = sort.split(':');
    const sign = direction === 'desc' ? -1 : 1;
    const folders = entries.filter((entry): entry is FolderEntry => entry.kind === 'folder');
    const files = entries.filter((entry): entry is FileEntry => entry.kind === 'file');
    folders.sort((a, b) => sign * a.name.localeCompare(b.name));
    files.sort((a, b) => {
        if (field === 'size') return sign * (a.size - b.size);
        if (field === 'modified') {
            const aTime = a.lastModified ? Date.parse(a.lastModified) : 0;
            const bTime = b.lastModified ? Date.parse(b.lastModified) : 0;
            return sign * (aTime - bTime);
        }
        return sign * a.name.localeCompare(b.name);
    });
    return [...folders, ...files];
}

function PrefixChips({ bucketName, prefix, onNavigate }: { bucketName: string; prefix: string; onNavigate: (prefix: string) => void }) {
    const segments = prefix.split('/').filter(Boolean);
    return (
        <nav aria-label="Object prefix" className="flex flex-wrap items-center gap-1">
            <Button variant={segments.length === 0 ? 'secondary' : 'ghost'} size="sm" className="font-mono text-xs" onClick={() => onNavigate('')}>
                {bucketName}
            </Button>
            {segments.map((segment, index) => (
                <span key={`${segment}-${index}`} className="flex items-center gap-1">
                    <IconChevronRight aria-hidden className="text-muted-foreground size-3.5" />
                    <Button
                        variant={index === segments.length - 1 ? 'secondary' : 'ghost'}
                        size="sm"
                        className="font-mono text-xs"
                        onClick={() => onNavigate(`${segments.slice(0, index + 1).join('/')}/`)}
                    >
                        {segment}
                    </Button>
                </span>
            ))}
        </nav>
    );
}

/**
 * Frame 31 middle panel: prefix-grouped object grid over the flat
 * GET buckets/:name/files listing, with client-side sort + pagination
 * (the route exposes no paging params).
 */
export function ObjectBrowserPanel({
    bucketName,
    prefix,
    onNavigate,
    rows,
    total,
    isLoading,
    error,
    onRetry,
    sort,
    onSortChange,
    page,
    limit,
    onPageChange,
    onLimitChange,
    selectedKey,
    onSelectFile,
    hasSearch,
    onClearSearch,
    onRequestUpload,
}: {
    bucketName: string;
    prefix: string;
    onNavigate: (prefix: string) => void;
    /** Current page of entries (folders first). */
    rows: BrowserEntry[];
    /** Entry count after search filtering, before pagination. */
    total: number;
    isLoading: boolean;
    error: unknown;
    onRetry: () => void;
    sort: string;
    onSortChange: (sort: string) => void;
    page: number;
    limit: number;
    onPageChange: (page: number) => void;
    onLimitChange: (limit: number) => void;
    selectedKey: string | null;
    onSelectFile: (key: string) => void;
    hasSearch: boolean;
    onClearSearch: () => void;
    onRequestUpload: () => void;
}) {
    const columns: DataTableColumn<BrowserEntry>[] = [
        {
            key: 'key',
            header: 'Object key',
            sortKey: 'key',
            cell: (row) => {
                if (row.kind === 'folder') {
                    return (
                        <span className="flex items-center gap-2">
                            <IconFolder aria-hidden className="text-muted-foreground size-4 shrink-0" />
                            <span className="min-w-0 truncate font-mono text-xs font-medium">{row.name}/</span>
                            <span className="text-muted-foreground shrink-0 text-xs">
                                {formatNumber(row.count)} {row.count === 1 ? 'object' : 'objects'}
                            </span>
                        </span>
                    );
                }
                const Icon = fileTypeIcon(row.name);
                const selected = row.key === selectedKey;
                return (
                    <span className="flex items-center gap-2">
                        <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
                        <span className={cx('min-w-0 truncate font-mono text-xs', selected && 'font-semibold')}>{row.name}</span>
                        {selected ? (
                            <>
                                <IconCircleDot aria-hidden className="text-primary size-3.5 shrink-0" />
                                <span className="sr-only">(selected)</span>
                            </>
                        ) : null}
                    </span>
                );
            },
        },
        {
            key: 'size',
            header: 'Size',
            sortKey: 'size',
            className: 'w-24 tabular-nums',
            cell: (row) => (row.kind === 'file' ? formatBytes(row.size) : <span className="text-muted-foreground">{'\u2014'}</span>),
        },
        {
            key: 'modified',
            header: 'Modified',
            sortKey: 'modified',
            className: 'w-32',
            cell: (row) =>
                row.kind === 'file' ? (
                    <span className="text-muted-foreground">{formatRelativeTime(row.lastModified)}</span>
                ) : (
                    <span className="text-muted-foreground">{'\u2014'}</span>
                ),
        },
    ];

    const empty = hasSearch ? (
        <EmptyState
            icon={IconFilterOff}
            title="No objects match your search"
            description="Try a different key or clear the search."
            action={
                <Button variant="outline" onClick={onClearSearch}>
                    <IconFilterOff aria-hidden />
                    Clear search
                </Button>
            }
        />
    ) : (
        <EmptyState
            icon={IconFolderOpen}
            title="No objects here"
            description="Nothing is stored under this prefix yet. Uploads land at the bucket root."
            action={
                <Button onClick={onRequestUpload}>
                    <IconUpload aria-hidden />
                    Upload files
                </Button>
            }
        />
    );

    return (
        <section aria-label="Object browser" className="flex min-w-0 flex-col gap-3">
            {bucketName ? <PrefixChips bucketName={bucketName} prefix={prefix} onNavigate={onNavigate} /> : null}
            <DataTable
                aria-label="Bucket objects"
                columns={columns}
                rows={rows}
                rowKey={(row) => `${row.kind}-${row.kind === 'file' ? row.key : row.prefix}`}
                isLoading={isLoading}
                error={error}
                onRetry={onRetry}
                empty={empty}
                sort={sort}
                onSortChange={onSortChange}
                onRowClick={(row) => (row.kind === 'folder' ? onNavigate(row.prefix) : onSelectFile(row.key))}
            />
            {total > 0 ? (
                <>
                    <p className="text-muted-foreground text-sm">
                        Objects in <span className="font-mono text-xs">{prefix ? `${bucketName}/${prefix.replace(/\/$/, '')}` : bucketName}</span>
                    </p>
                    <TablePagination page={page} limit={limit} total={total} onPageChange={onPageChange} onLimitChange={onLimitChange} />
                </>
            ) : null}
        </section>
    );
}
