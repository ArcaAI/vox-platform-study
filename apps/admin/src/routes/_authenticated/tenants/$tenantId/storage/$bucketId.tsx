/**
 * TASK-407 — Stores bucket-detail (design §5.7 `40 · Store Detail`, spec-only):
 * bucket meta + provider-config panel (masked credentialsRef) + access-keys
 * table (read-only) + read-only object browser with usage-vs-quota bar.
 * No object deletion, no key creation — mutations stay out of scope.
 */

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Input } from '@arcaai/ui/input';
import { Progress } from '@arcaai/ui/progress';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import {
  useStorageKeys,
  useTenantBuckets,
  useTenantStorageConfig,
  type StorageKey,
  type TenantBucket,
  type TenantBucketObject,
  type TenantStorageConfig,
} from '@arcaai/vox';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, FileBox, KeyRound, Search, Settings2, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { resourceStatusLabel, resourceStatusRole } from '@/features/data-grid/status';
import { formatBytes } from '@/features/platform-dashboard';
import { bucketTypeLabel, fileNameOf, keysForBucket, objectsTotalBytes, quotaPct } from '@/features/storage/store-format';
import { formatDateTime } from '@/lib/utils';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/storage/$bucketId')({
  component: BucketDetailPage,
});

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** credentialsRef is a Vault pointer — mask everything but the tail. */
function maskRef(ref: string): string {
  return ref.length <= 6 ? '•••' : `•••${ref.slice(-6)}`;
}

function BucketDetailPage() {
  const { tenantId, bucketId } = Route.useParams();
  const { get, listObjects } = useTenantBuckets();
  const { effective } = useTenantStorageConfig();
  const { list: listKeys } = useStorageKeys();

  const [bucket, setBucket] = useState<TenantBucket | null>(null);
  const [config, setConfig] = useState<TenantStorageConfig | null>(null);
  const [keys, setKeys] = useState<StorageKey[]>([]);
  const [objects, setObjects] = useState<TenantBucketObject[] | null>(null);
  const [objectsError, setObjectsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [prefix, setPrefix] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    void get(bucketId)
      .then((b) => {
        if (cancelled) return;
        if (!b) setNotFound(true);
        else setBucket(b);
      })
      .catch(() => !cancelled && setNotFound(true))
      .finally(() => !cancelled && setLoading(false));
    // Side panels degrade independently — a failure leaves the section empty.
    void effective(bucketId)
      .then((c) => !cancelled && setConfig(c))
      .catch(() => undefined);
    void listKeys()
      .then((k) => !cancelled && setKeys(k))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucketId]);

  useEffect(() => {
    let cancelled = false;
    setObjects(null);
    setObjectsError(null);
    void listObjects(bucketId, prefix || undefined)
      .then((o) => !cancelled && setObjects(o))
      .catch((e) => !cancelled && setObjectsError(e instanceof Error ? e.message : 'Failed to list objects'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucketId, prefix]);

  const scopedKeys = useMemo(() => keysForBucket(keys, bucketId), [keys, bucketId]);
  const totalBytes = objects ? objectsTotalBytes(objects) : null;
  const quotaBytes = bucket && typeof bucket.quotaBytes === 'number' ? bucket.quotaBytes : null;
  const pct = totalBytes != null ? quotaPct(totalBytes, quotaBytes) : null;

  if (loading && !bucket) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (notFound || !bucket) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileBox />
          </EmptyMedia>
          <EmptyTitle>Bucket not found</EmptyTitle>
          <EmptyDescription>This bucket doesn’t exist in this tenant or you don’t have access to it.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const status = str(bucket.resourceStatus) ?? str(bucket.status);
  const purpose = str(bucket.purpose);
  const slug = str(bucket.slug);
  const pathPattern = str(bucket.pathPattern);
  const providerChip = [str(bucket.provider), str(bucket.region)].filter(Boolean).join(' · ');
  const configRows: Array<[string, string | null]> = config
    ? [
        ['Backend', str(config.backend) ?? str(config.provider)],
        ['Topology', str(config.topology)],
        ['Endpoint', str(config.endpoint)],
        ['Region', str(config.region)],
        ['Account', str(config.accountName)],
        ['Container prefix', str(config.containerPrefix)],
        ['Credentials ref', str(config.credentialsRef) ? maskRef(str(config.credentialsRef) as string) : null],
      ]
    : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="icon" aria-label="Back to buckets">
            <Link to="/tenants/$tenantId/storage" params={{ tenantId }}>
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate font-mono text-lg font-semibold">{bucket.name || bucket.id}</h2>
              {purpose ? <Badge variant="secondary">{purpose}</Badge> : null}
              <Badge variant="outline">{bucketTypeLabel(str(bucket.bucketType))}</Badge>
              {status ? <StatusBadge label={resourceStatusLabel(status)} colorRole={resourceStatusRole(status)} /> : null}
            </div>
            <p className="truncate text-sm text-muted-foreground">
              {slug ? <span className="font-mono">{slug}</span> : null}
              {slug && providerChip ? ' · ' : null}
              {providerChip || null}
            </p>
          </div>
        </div>
      </div>

      {/* Usage vs quota — quotaBytes is REAL since TASK-386. */}
      <Card className="p-5">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Usage</h3>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <div>
            <span className="text-2xl font-semibold tabular-nums">{totalBytes != null ? formatBytes(totalBytes) : '—'}</span>
            <span className="ml-2 text-sm text-muted-foreground">
              {objects ? `across ${objects.length} object${objects.length === 1 ? '' : 's'}` : 'loading objects…'}
              {quotaBytes != null ? ` · quota ${formatBytes(quotaBytes)}` : ' · no quota set'}
            </span>
          </div>
          {pct != null ? <span className="text-sm font-medium tabular-nums text-muted-foreground">{pct}%</span> : null}
        </div>
        {pct != null ? <Progress className="mt-3" value={pct} aria-label={`Bucket usage ${pct}%`} /> : null}
        {pathPattern ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Path pattern <span className="font-mono">{pathPattern}</span>
          </p>
        ) : null}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Provider config (effective = bucket override → tenant default). */}
        <Card className="p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Provider config</h3>
            <Settings2 className="size-4 shrink-0 text-muted-foreground" />
          </div>
          {configRows.filter(([, v]) => v).length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No storage config — served by the platform default provider.</p>
          ) : (
            <dl className="mt-3 space-y-2 text-sm">
              {configRows
                .filter(([, v]) => v)
                .map(([label, value]) => (
                  <div key={label} className="flex items-baseline justify-between gap-4">
                    <dt className="shrink-0 text-muted-foreground">{label}</dt>
                    <dd className="truncate font-mono text-xs">{value}</dd>
                  </div>
                ))}
            </dl>
          )}
        </Card>

        {/* Access keys scoped to this bucket — read-only (creation/rotation not in scope). */}
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Access keys</h3>
            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
          </div>
          {scopedKeys.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">No access keys scoped to this bucket.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground/70">
                  <th className="px-5 py-2.5 font-medium">Key</th>
                  <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Permissions</th>
                  <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Last used</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {scopedKeys.map((k) => {
                  const perms = Array.isArray(k.permissions) ? (k.permissions as unknown[]).map(String) : [];
                  return (
                    <tr key={k.id}>
                      <td className="px-5 py-3">
                        <div className="flex flex-col">
                          <span className="font-medium">{str(k.label) ?? str(k.name) ?? k.id}</span>
                          {str(k.accessKeyId) ? <span className="font-mono text-xs text-muted-foreground">{k.accessKeyId as string}</span> : null}
                        </div>
                      </td>
                      <td className="hidden px-5 py-3 sm:table-cell">
                        {perms.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {perms.map((p) => (
                              <Badge key={p} variant="secondary" className="font-normal">
                                {p}
                              </Badge>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="hidden px-5 py-3 text-muted-foreground sm:table-cell">{formatDateTime(str(k.lastUsedAt))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {/* Read-only object browser (MinIO-backed listing, TASK-376). */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Objects</h3>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="Filter by prefix…"
              className="h-9 w-56 pl-8"
              aria-label="Filter objects by prefix"
            />
          </div>
        </div>
        {objectsError ? (
          <div role="alert" className="flex flex-col items-center gap-2 p-10 text-center">
            <TriangleAlert className="size-8 text-destructive" />
            <p className="font-medium">Couldn’t list objects</p>
            <p className="text-sm text-muted-foreground">{objectsError}</p>
          </div>
        ) : objects == null ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : objects.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileBox />
              </EmptyMedia>
              <EmptyTitle>No objects</EmptyTitle>
              <EmptyDescription>{prefix ? 'No objects match this prefix.' : 'This bucket is empty.'}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground/70">
                <th className="px-5 py-2.5 font-medium">Object</th>
                <th className="px-5 py-2.5 font-medium">Size</th>
                <th className="hidden px-5 py-2.5 font-medium md:table-cell">Modified</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {objects.map((o) => (
                <tr key={o.key}>
                  <td className="max-w-0 px-5 py-2.5">
                    <div className="flex flex-col">
                      <span className="truncate font-medium">{fileNameOf(o.key)}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{o.key}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-5 py-2.5 tabular-nums text-muted-foreground">{formatBytes(o.size)}</td>
                  <td className="hidden whitespace-nowrap px-5 py-2.5 text-muted-foreground md:table-cell">
                    {formatDateTime(o.lastModified ?? null)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          Read-only browser — objects cannot be modified or deleted here.
        </p>
      </Card>
    </div>
  );
}
