'use client';

import { useMemo, useState } from 'react';
import { IconArrowBackUp, IconCloudDownload, IconDatabase, IconFolder } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useModelStoreBuckets, useModelStoreObjects } from '../api/model-store-hooks';
import { preferredModelStoreBucket } from '../api/model-store-client';
import { HuggingFaceFetchDrawer } from './huggingface-fetch-drawer';

/** Bytes → a size a human reads at a glance. Binary units, because object stores report binary. */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Split a flat key listing into the folders and files directly under `prefix`.
 *
 * The gateway's listing is flat with `prefix` as its only filter, so the
 * folder structure a model store actually has (one prefix per model, one file
 * per shard) is only visible if the client derives it. Without this the tab is
 * a thousand-row wall of shard filenames.
 */
export function splitByPrefix(keys: readonly { key: string; size: number; lastModified?: string }[], prefix: string) {
  const folders = new Map<string, { count: number; size: number }>();
  const files: { key: string; size: number; lastModified?: string }[] = [];

  for (const object of keys) {
    if (!object.key.startsWith(prefix)) continue;
    const rest = object.key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push(object);
    } else {
      const folder = rest.slice(0, slash);
      const current = folders.get(folder) ?? { count: 0, size: 0 };
      folders.set(folder, { count: current.count + 1, size: current.size + object.size });
    }
  }

  return {
    folders: [...folders.entries()].sort(([a], [b]) => a.localeCompare(b)),
    files: files.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/**
 * MODEL STORE — the object-storage side of the AI platform, plus the
 * HuggingFace acquisition flow (OD-2: HF is a model SOURCE, so bringing a model
 * in is a STORAGE capability here, not a provider configuration).
 *
 * Read-only browsing on purpose: `/storage` owns upload, presign and delete.
 * What this tab adds is the question the storage browser cannot answer — WHICH
 * weights this platform actually holds, next to the catalogue that names them
 * and the configurations that select them.
 */
export function ModelStoreTab() {
  const buckets = useModelStoreBuckets();
  // `chosen` is what the OPERATOR picked; the effective bucket falls back to a
  // pre-selection DERIVED from the list the server returned. Derived rather
  // than written into state by an effect: an effect would cascade a render and,
  // worse, would need a second flag to distinguish "not chosen yet" from
  // "deliberately cleared". The pre-selection never invents a bucket name, so
  // it cannot become hardcoded configuration.
  const [chosen, setChosen] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [fetchOpen, setFetchOpen] = useState(false);

  const bucket = chosen ?? preferredModelStoreBucket(buckets.data ?? []);

  const objects = useModelStoreObjects(bucket, prefix);
  const { folders, files } = useMemo(() => splitByPrefix(objects.data ?? [], prefix), [objects.data, prefix]);

  const parentPrefix = prefix === '' ? null : prefix.replace(/[^/]*\/$/, '');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="store-bucket">Bucket</Label>
          {buckets.isPending ? (
            <Skeleton className="h-9 w-56" />
          ) : (
            <NativeSelect
              id="store-bucket"
              value={bucket ?? ''}
              onChange={(event) => {
                setChosen(event.target.value || null);
                setPrefix('');
              }}
              className="w-56"
            >
              <option value="">Select a bucket…</option>
              {(buckets.data ?? []).map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </div>
        <Button size="sm" onClick={() => setFetchOpen(true)}>
          <IconCloudDownload aria-hidden />
          Fetch from HuggingFace
        </Button>
      </div>

      {prefix !== '' ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Button variant="outline" size="sm" onClick={() => setPrefix(parentPrefix ?? '')}>
            <IconArrowBackUp aria-hidden />
            Up one level
          </Button>
          <span className="text-muted-foreground font-mono break-all">{prefix}</span>
        </div>
      ) : null}

      {buckets.error ? (
        <ErrorState error={buckets.error} onRetry={() => void buckets.refetch()} />
      ) : !bucket ? (
        <EmptyState icon={IconDatabase} title="No bucket selected" description="Choose the bucket your model weights are stored in." />
      ) : objects.isPending ? (
        <div className="flex flex-col gap-2 rounded-md border p-3" aria-hidden>
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : objects.error ? (
        <ErrorState error={objects.error} onRetry={() => void objects.refetch()} />
      ) : folders.length === 0 && files.length === 0 ? (
        <EmptyState
          icon={IconDatabase}
          title="Nothing stored here"
          description="This bucket holds no objects under the current prefix. Catalogue a HuggingFace repository to have the weight fetcher populate it."
          action={
            <Button size="sm" onClick={() => setFetchOpen(true)}>
              <IconCloudDownload aria-hidden />
              Fetch from HuggingFace
            </Button>
          }
        />
      ) : (
        <div className="rounded-md border">
          <Table aria-label={`Objects in ${bucket}`}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Size</TableHead>
                <TableHead scope="col">Last modified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {folders.map(([folder, stats]) => (
                <TableRow key={`dir:${folder}`}>
                  <TableCell>
                    <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setPrefix(`${prefix}${folder}/`)}>
                      <IconFolder aria-hidden />
                      <span className="font-mono text-xs">{folder}/</span>
                    </Button>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{formatSize(stats.size)}</TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="outline">{stats.count} object(s)</Badge>
                  </TableCell>
                </TableRow>
              ))}
              {files.map((object) => (
                <TableRow key={object.key}>
                  <TableCell className="font-mono text-xs break-all">{object.key.slice(prefix.length)}</TableCell>
                  <TableCell className="font-mono text-xs">{formatSize(object.size)}</TableCell>
                  <TableCell className="text-xs">{object.lastModified ? new Date(object.lastModified).toLocaleString() : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <HuggingFaceFetchDrawer open={fetchOpen} onOpenChange={setFetchOpen} />
    </div>
  );
}
