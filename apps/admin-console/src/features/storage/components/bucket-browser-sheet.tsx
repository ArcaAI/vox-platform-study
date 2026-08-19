'use client';

import { useState } from 'react';
import { IconChevronRight, IconFile, IconFolder, IconFolderOpen } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatBytes, formatNumber, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useObjects } from '../api/hooks';
import type { BucketObject, TenantBucket } from '../api/types';

interface FolderEntry {
  kind: 'folder';
  name: string;
  count: number;
}

interface FileEntry {
  kind: 'file';
  name: string;
  size: number;
  lastModified?: string;
}

type BrowserEntry = FolderEntry | FileEntry;

/** Groups flat object keys under the current prefix into folders + files. */
function deriveEntries(objects: BucketObject[], prefix: string): BrowserEntry[] {
  const folders = new Map<string, number>();
  const files: FileEntry[] = [];
  for (const object of objects) {
    const rest = object.key.startsWith(prefix) ? object.key.slice(prefix.length) : object.key;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      if (rest) files.push({ kind: 'file', name: rest, size: object.size, lastModified: object.lastModified });
    } else {
      const folder = rest.slice(0, slash);
      folders.set(folder, (folders.get(folder) ?? 0) + 1);
    }
  }
  const folderEntries: FolderEntry[] = [...folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({ kind: 'folder', name, count }));
  return [...folderEntries, ...files.sort((a, b) => a.name.localeCompare(b.name))];
}

function PrefixChips({ prefix, onNavigate }: { prefix: string; onNavigate: (prefix: string) => void }) {
  const segments = prefix.split('/').filter(Boolean);
  return (
    <nav aria-label="Object prefix" className="flex flex-wrap items-center gap-1">
      <Button variant={segments.length === 0 ? 'secondary' : 'ghost'} size="sm" onClick={() => onNavigate('')}>
        Root
      </Button>
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`} className="flex items-center gap-1">
          <IconChevronRight aria-hidden className="text-muted-foreground size-3.5" />
          <Button
            variant={index === segments.length - 1 ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => onNavigate(`${segments.slice(0, index + 1).join('/')}/`)}
          >
            {segment}
          </Button>
        </span>
      ))}
    </nav>
  );
}

function BrowserPanel({ bucket }: { bucket: TenantBucket }) {
  const [prefix, setPrefix] = useState('');
  const { data, isPending, error, refetch } = useObjects(bucket.id, prefix || undefined);
  const entries = deriveEntries(data ?? [], prefix);

  return (
    <div className="flex flex-col gap-3">
      <PrefixChips prefix={prefix} onNavigate={setPrefix} />
      {isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : error ? (
        <ErrorState title={'Couldn\u2019t list the objects'} error={error} onRetry={() => refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState icon={IconFolderOpen} title="No objects under this prefix" description="Uploads land here on first use." />
      ) : (
        <ul className="flex flex-col">
          {entries.map((entry) =>
            entry.kind === 'folder' ? (
              <li key={`folder-${entry.name}`} className="border-b last:border-b-0">
                <button
                  type="button"
                  className="hover:bg-muted/50 focus-visible:ring-ring flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-left text-sm outline-none focus-visible:ring-2"
                  onClick={() => setPrefix(`${prefix}${entry.name}/`)}
                >
                  <IconFolder aria-hidden className="text-muted-foreground size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-medium">{entry.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {formatNumber(entry.count)} {entry.count === 1 ? 'object' : 'objects'}
                  </span>
                </button>
              </li>
            ) : (
              <li key={`file-${entry.name}`} className="flex items-center gap-2 border-b px-2 py-2 text-sm last:border-b-0">
                <IconFile aria-hidden className="text-muted-foreground size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.name}</span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatBytes(entry.size)}</span>
                <span className="text-muted-foreground shrink-0 text-xs">{formatRelativeTime(entry.lastModified)}</span>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

/** Frame 14 drill-in: prefix object browser inside the screen (no new route). */
export function BucketBrowserSheet({ bucket, onOpenChange }: { bucket: TenantBucket | null; onOpenChange: (open: boolean) => void }) {
  return (
    <DetailDrawer
      open={bucket !== null}
      onOpenChange={onOpenChange}
      title={bucket?.name ?? 'Bucket'}
      meta={
        bucket ? (
          <span>
            <span className="font-mono">{bucket.slug}</span> {'\u00b7'} prefix-based object browser (read-only)
          </span>
        ) : null
      }
    >
      {bucket ? <BrowserPanel key={bucket.id} bucket={bucket} /> : null}
    </DetailDrawer>
  );
}
