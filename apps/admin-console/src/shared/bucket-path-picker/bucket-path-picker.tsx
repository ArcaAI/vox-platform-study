'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconFile, IconFolder } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { getJson } from '@/shared/api';
import { cx } from '@/shared/cx';
import { formatBytes } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { deriveEntries, sortEntries, type ListedObject } from './entries';
import { PrefixChips } from './prefix-chips';

export interface BucketPathPickerProps {
  /** Bucket to browse (`GET storage/buckets/:bucket/files?prefix=`). */
  bucket: string;
  /** The selected path: a folder prefix (trailing `/`) or a full object key. Empty = nothing selected. */
  value: string;
  /** Called with the picked path — a folder ends with `/`, a file is its full key. */
  onChange: (path: string) => void;
  /** Where browsing starts. Defaults to the bucket root. */
  initialPrefix?: string;
  className?: string;
}

/**
 * Browse a storage bucket and pick a folder or a file (TASK-1023). Folders are derived client-side from the flat
 * key listing; clicking a folder's name opens it, its "Select" button picks it. Reusable by any screen that needs
 * "a path inside a bucket" without typing one.
 */
export function BucketPathPicker({ bucket, value, onChange, initialPrefix = '', className }: BucketPathPickerProps) {
  const [prefix, setPrefix] = useState(initialPrefix);
  const listing = useQuery({
    queryKey: ['bucket-path-picker', bucket, prefix] as const,
    queryFn: () => getJson<ListedObject[]>(`storage/buckets/${encodeURIComponent(bucket)}/files`, { prefix: prefix || undefined }),
    staleTime: 15_000,
    retry: false,
  });
  const entries = useMemo(() => sortEntries(deriveEntries((listing.data ?? []).filter((object) => object.key.startsWith(prefix)), prefix), 'key:asc'), [listing.data, prefix]);

  return (
    <div className={cx('flex min-w-0 flex-col gap-2', className)}>
      <PrefixChips bucketName={bucket} prefix={prefix} onNavigate={setPrefix} />
      <div className="max-h-72 overflow-y-auto rounded-md border">
        {listing.isLoading ? (
          <div role="status" aria-label="Loading bucket contents" className="flex flex-col gap-2 p-2">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : listing.error ? (
          <ErrorState title="Couldn’t list the bucket" error={listing.error} onRetry={() => void listing.refetch()} />
        ) : entries.length === 0 ? (
          <EmptyState icon={IconFolder} title="Nothing here" description="This folder holds no files." />
        ) : (
          <ul className="flex flex-col divide-y">
            {entries.map((entry) => {
              const path = entry.kind === 'folder' ? entry.prefix : entry.key;
              const selected = value === path;
              return (
                <li key={path} className="flex items-center gap-2 px-2 py-1">
                  {entry.kind === 'folder' ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="min-w-0 flex-1 justify-start font-mono text-xs"
                        aria-label={`Open folder ${entry.name}`}
                        onClick={() => setPrefix(entry.prefix)}
                      >
                        <IconFolder aria-hidden />
                        <span className="truncate">{entry.name}</span>
                        <span className="text-muted-foreground">({entry.count})</span>
                      </Button>
                      <Button
                        type="button"
                        variant={selected ? 'secondary' : 'outline'}
                        size="sm"
                        aria-label={`Select folder ${entry.name}`}
                        aria-pressed={selected}
                        onClick={() => onChange(entry.prefix)}
                      >
                        {selected ? 'Selected' : 'Select'}
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="flex min-w-0 flex-1 items-center gap-2 px-2 font-mono text-xs">
                        <IconFile aria-hidden className="size-4 shrink-0" />
                        <span className="truncate">{entry.name}</span>
                        <span className="text-muted-foreground shrink-0">{formatBytes(entry.size)}</span>
                      </span>
                      <Button
                        type="button"
                        variant={selected ? 'secondary' : 'outline'}
                        size="sm"
                        aria-label={`Select file ${entry.name}`}
                        aria-pressed={selected}
                        onClick={() => onChange(entry.key)}
                      >
                        {selected ? 'Selected' : 'Select'}
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {prefix ? (
        <Button
          type="button"
          variant={value === prefix ? 'secondary' : 'outline'}
          size="sm"
          className="self-start"
          aria-label="Select this folder"
          aria-pressed={value === prefix}
          onClick={() => onChange(prefix)}
        >
          {value === prefix ? 'This folder selected' : 'Select this folder'}
        </Button>
      ) : null}
    </div>
  );
}
