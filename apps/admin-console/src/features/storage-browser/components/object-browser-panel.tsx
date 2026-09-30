'use client';

import { useMemo } from 'react';
import { IconCircleDot, IconFilterOff, IconFolder, IconFolderOpen, IconUpload } from '@tabler/icons-react';
import { VirtualizedDataGrid, type ColumnDef } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { cx } from '@/shared/cx';
import { formatBytes, formatNumber, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { deriveEntries, sortEntries, type BrowserEntry, type FileEntry, type FolderEntry } from '@/shared/bucket-path-picker/entries';
import { PrefixChips } from '@/shared/bucket-path-picker/prefix-chips';
import { fileTypeIcon, guessContentType } from './file-meta';

// The pure listing helpers and the breadcrumb moved to `@/shared/bucket-path-picker` (TASK-1023) so the
// AI-models register sheet can reuse them; re-exported here so the storage screens keep their imports.
export { deriveEntries, PrefixChips, sortEntries };
export type { BrowserEntry, FileEntry, FolderEntry };

/** Best-effort type label for the grid `type` column. */
function entryTypeLabel(entry: BrowserEntry): string {
  if (entry.kind === 'folder') return 'Folder';
  return guessContentType(entry.name) ?? 'File';
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
  readOnly = false,
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
  /** Omit in `readOnly` mode — the empty state then carries no upload CTA. */
  onRequestUpload?: () => void;
  /**
   * TASK-932 "All tenants" browse view (an unscoped platform admin with no
   * working tenant): folders still navigate, but file rows are inert — no
   * download/delete surface exists for that scope — and the upload CTA is
   * hidden.
   */
  readOnly?: boolean;
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
                  <IconCircleDot aria-hidden className="text-foreground size-3.5 shrink-0" />
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
      description={
        onRequestUpload ? 'Nothing is stored under this prefix yet. Uploads land at the bucket root.' : 'Nothing is stored under this prefix yet.'
      }
      action={
        onRequestUpload ? (
          <Button onClick={onRequestUpload}>
            <IconUpload aria-hidden />
            Upload files
          </Button>
        ) : undefined
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
      onRowClick={(row) => {
        if (row.kind === 'folder') {
          onNavigate(row.prefix);
        } else if (!readOnly) {
          onSelectFile(row.key);
        }
      }}
    />
  );
}
