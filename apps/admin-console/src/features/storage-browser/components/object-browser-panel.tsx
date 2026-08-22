'use client';

import { useMemo } from 'react';
import { IconChevronRight, IconCircleDot, IconFilterOff, IconFolder, IconFolderOpen, IconUpload } from '@tabler/icons-react';
import { VirtualizedDataGrid, type ColumnDef } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { cx } from '@/shared/cx';
import { formatBytes, formatNumber, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import type { StorageObject } from '../api/types';
import { fileTypeIcon, guessContentType } from './file-meta';

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

/** Best-effort type label for the grid `type` column. */
function entryTypeLabel(entry: BrowserEntry): string {
  if (entry.kind === 'folder') return 'Folder';
  return guessContentType(entry.name) ?? 'File';
}

/**
 * Breadcrumb path bar over the current prefix (frame 31): the root chip is the
 * bucket name; each segment navigates into that prefix. Rendered in the screen
 * toolbar, above the fill-height grid.
 */
export function PrefixChips({ bucketName, prefix, onNavigate }: { bucketName: string; prefix: string; onNavigate: (prefix: string) => void }) {
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
 * Frame 31 object grid (redesign): the fill-height primary surface \u2014 a
 * prefix-grouped object grid over the flat GET buckets/:name/files listing,
 * with client-side sort + pagination (the route exposes no paging params).
 * The breadcrumb path bar and toolbar live in the screen; folders sort first.
 */
export function ObjectBrowserPanel({
  onNavigate,
  rows,
  isLoading,
  error,
  onRetry,
  selectedKey,
  onSelectFile,
  hasSearch,
  onClearSearch,
  onRequestUpload,
}: {
  onNavigate: (prefix: string) => void;
  /** Folders-first entries for the current prefix; the grid paginates client-side. */
  rows: BrowserEntry[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  selectedKey: string | null;
  onSelectFile: (key: string) => void;
  hasSearch: boolean;
  onClearSearch: () => void;
  onRequestUpload: () => void;
}) {
  const columns = useMemo<ColumnDef<BrowserEntry>[]>(
    () => [
      {
        id: 'name',
        header: 'Name',
        enableSorting: false,
        meta: { label: 'Name' },
        cell: ({ row }) => {
          const entry = row.original;
          if (entry.kind === 'folder') {
            return (
              <span className="flex items-center gap-2">
                <IconFolder aria-hidden className="text-muted-foreground size-4 shrink-0" />
                <span className="min-w-0 truncate font-mono text-xs font-medium">{entry.name}/</span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {formatNumber(entry.count)} {entry.count === 1 ? 'object' : 'objects'}
                </span>
              </span>
            );
          }
          const Icon = fileTypeIcon(entry.name);
          const selected = entry.key === selectedKey;
          return (
            <span className="flex items-center gap-2">
              <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
              <span className={cx('min-w-0 truncate font-mono text-xs', selected && 'font-medium')}>{entry.name}</span>
              {selected ? (
                <>
                  <IconCircleDot aria-hidden className="text-primary size-3.5 shrink-0" />
                  <span className="sr-only">(selected)</span>
                </>
              ) : null}
            </span>
          );
        },
        size: 320,
        minSize: 200,
      },
      {
        id: 'type',
        header: 'Type',
        enableSorting: false,
        meta: { label: 'Type' },
        cell: ({ row }) => <span className="text-muted-foreground font-mono text-xs">{entryTypeLabel(row.original)}</span>,
        size: 160,
        minSize: 96,
      },
      {
        id: 'size',
        header: 'Size',
        enableSorting: false,
        meta: { label: 'Size' },
        cell: ({ row }) =>
          row.original.kind === 'file' ? (
            <span className="tabular-nums">{formatBytes(row.original.size)}</span>
          ) : (
            <span className="text-muted-foreground">{'\u2014'}</span>
          ),
        size: 96,
      },
      {
        id: 'modified',
        header: 'Modified',
        enableSorting: false,
        meta: { label: 'Modified' },
        cell: ({ row }) =>
          row.original.kind === 'file' ? (
            <span className="text-muted-foreground">{formatRelativeTime(row.original.lastModified)}</span>
          ) : (
            <span className="text-muted-foreground">{'\u2014'}</span>
          ),
        size: 128,
      },
    ],
    [selectedKey],
  );

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
    <VirtualizedDataGrid<BrowserEntry>
      aria-label="Bucket objects"
      columns={columns}
      data={rows}
      getRowId={(row) => `${row.kind}-${row.kind === 'file' ? row.key : row.prefix}`}
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
      isLoading={isLoading}
      error={error instanceof Error ? error : null}
      errorState={(err) => <ErrorState error={err} onRetry={onRetry} />}
      emptyState={empty}
      onRowClick={(row) => (row.kind === 'folder' ? onNavigate(row.prefix) : onSelectFile(row.key))}
    />
  );
}
