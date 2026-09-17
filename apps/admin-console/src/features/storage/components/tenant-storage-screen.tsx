'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { IconBucket, IconBuilding, IconDatabase, IconDots, IconFilterOff, IconFolderOpen, IconPlugConnected, IconTrash } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { VirtualizedDataGrid, includesSomeFilter, type ColumnDef } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { GatewayError } from '@/shared/api';
import { useSession } from '@/shared/auth';
import { SYSTEM_TENANT_ID, useTenantCatalog, useTenantNames } from '@/shared/catalog';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import type { FilterOption } from '@/shared/data/filter-bar';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { NameWithId } from '@/shared/data/name-with-id';
import { formatBytes, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useAdoptBucket, useBuckets, useDeleteBucket, useProvisionTenantBuckets } from '../api/hooks';
import type { TenantBucket, TenantBucketPurpose } from '../api/types';
import { AccessKeysTab } from './access-keys-tab';
import { BucketBrowserSheet } from './bucket-browser-sheet';
import { BucketDefaultsTab } from './bucket-defaults-tab';
import { PlatformStorageDefaultPanel } from './platform-storage-default-panel';
import { StorageConfigsTab } from './storage-configs-tab';

const TAB_VALUES = ['buckets', 'defaults', 'configs', 'keys'] as const;

const PURPOSE_LABELS: Record<TenantBucketPurpose, string> = {
  AUDIO: 'Audio',
  ATTACHMENTS: 'Attachments',
  MISC: 'Misc',
  CUSTOM: 'Custom',
};

const PURPOSE_OPTIONS: FilterOption[] = Object.entries(PURPOSE_LABELS).map(([value, label]) => ({ value, label }));

const TYPE_OPTIONS: FilterOption[] = [
  { value: 'SYSTEM', label: 'System' },
  { value: 'CUSTOM', label: 'Custom' },
];

/**
 * `deleteBlockedReason` present = the caller cannot delete this bucket, and the
 * string says why. Deletion stays DISABLED rather than hidden so the capability
 * is still discoverable, and the reason is rendered as adjacent text rather
 * than a tooltip because a disabled Radix item takes no pointer events (UX
 * principles §7: a disabled control needs a visible reason).
 */
function BucketRowActions({
  bucket,
  onBrowse,
  onDelete,
  deleteBlockedReason,
}: {
  bucket: TenantBucket;
  onBrowse: () => void;
  onDelete: () => void;
  deleteBlockedReason?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Open actions for ${bucket.name}`} onClick={(event) => event.stopPropagation()}>
          <IconDots aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      {/* The portal content still bubbles through the React tree to the row's onClick. */}
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={onBrowse}>
          <IconFolderOpen aria-hidden />
          Browse objects
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={Boolean(deleteBlockedReason)} onSelect={onDelete}>
          <IconTrash aria-hidden />
          Delete
        </DropdownMenuItem>
        {deleteBlockedReason ? (
          <DropdownMenuLabel className="text-muted-foreground max-w-64 px-2 py-1 text-xs font-normal whitespace-normal">
            {deleteBlockedReason}
          </DropdownMenuLabel>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Why this row's Delete cannot succeed, or `undefined` when it can.
 *
 * Every branch mirrors a refusal the gateway ALREADY makes, so the menu never
 * offers a call that is guaranteed to fail:
 *   - a PLATFORM bucket is deletable, but only by a platform administrator
 *     (TASK-967 OD-2) — checked FIRST, because such a row is stamped SYSTEM
 *     and the next branch would otherwise refuse it;
 *   - a SYSTEM bucket is refused by `TenantBucketService.deleteBucket` itself
 *     (403 "System buckets cannot be deleted") — the more fundamental blocker,
 *     since switching tenant would not help;
 *   - an unscoped session is refused for a CUSTOMER row by
 *     `assertUnscopedWriteAllowed` (404). A SYSTEM-tenant row is exempt: it has
 *     no customer to name, which is the whole reason the unscoped delete was
 *     narrowed in the first place.
 */
function deleteBlockedReason(
  bucket: TenantBucket,
  scoped: boolean,
  tenantNames: Map<string, string>,
  elevated: boolean,
): string | undefined {
  if (bucket.platform) {
    return elevated ? undefined : 'Platform buckets can only be deleted by a platform administrator.';
  }
  if (bucket.isSystemBucket) {
    return 'System buckets are provisioned with the tenant and cannot be deleted.';
  }
  if (!scoped) {
    if (bucket.tenantId === SYSTEM_TENANT_ID) return undefined;
    return `Deleting a bucket is tenant-scoped. Switch your working tenant to ${tenantNames.get(bucket.tenantId) ?? 'its owner'} to delete this one.`;
  }
  return undefined;
}

/**
 * Frame 14 buckets list: embedded grid (client search + faceted filters).
 * Spans all tenants for an unscoped elevated session, so the grid
 * carries a Tenant column and tenant/purpose/type filters.
 *
 * `scoped` is false for an unscoped elevated session (no working tenant). Such
 * a session can LIST every tenant's buckets and browse their objects; since
 * TASK-967 it can also DELETE a SYSTEM-tenant row (which includes every
 * platform bucket), because the id-addressed routes carry
 * `scope: 'super-admin'` and `assertUnscopedWriteAllowed` allows exactly that.
 * A CUSTOMER tenant's bucket still needs the working tenant selected, so its
 * Delete stays disabled with the reason naming the owner to switch to.
 */
function BucketsTab({ onProvision, scoped, elevated }: { onProvision: () => void; scoped: boolean; elevated: boolean }) {
  const { data, isLoading, error, refetch } = useBuckets();
  const deleteBucket = useDeleteBucket();
  const [browsing, setBrowsing] = useState<TenantBucket | null>(null);
  const [deleting, setDeleting] = useState<TenantBucket | null>(null);

  const tenantNames = useTenantNames();
  const tenantCatalog = useTenantCatalog();
  const tenantOptions = useMemo<FilterOption[]>(
    () => (tenantCatalog.data ?? []).map((tenant) => ({ value: tenant.id, label: tenant.name || tenant.key || tenant.id })),
    [tenantCatalog.data],
  );

  const buckets = data ?? [];

  const columns: ColumnDef<TenantBucket>[] = [
    { accessorKey: 'name', header: 'Name', meta: { label: 'Name' }, cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    {
      accessorKey: 'slug',
      header: 'Slug',
      meta: { label: 'Slug' },
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.slug}</span>,
    },
    {
      accessorKey: 'tenantId',
      header: 'Tenant',
      enableSorting: false,
      filterFn: includesSomeFilter,
      meta: { label: 'Tenant', variant: 'multiSelect', options: tenantOptions },
      size: 180,
      cell: ({ row }) => <NameWithId name={tenantNames.get(row.original.tenantId)} id={row.original.tenantId} />,
    },
    {
      accessorKey: 'purpose',
      header: 'Purpose',
      filterFn: includesSomeFilter,
      meta: { label: 'Purpose', variant: 'multiSelect', options: PURPOSE_OPTIONS },
      cell: ({ row }) => <Badge variant="outline">{PURPOSE_LABELS[row.original.purpose]}</Badge>,
    },
    {
      id: 'type',
      accessorFn: (row) => row.bucketType,
      header: 'Type',
      filterFn: includesSomeFilter,
      meta: { label: 'Type', variant: 'multiSelect', options: TYPE_OPTIONS },
      cell: ({ row }) => (
        <Badge variant={row.original.bucketType === 'SYSTEM' ? 'secondary' : 'outline'}>
          {row.original.bucketType === 'SYSTEM' ? 'System' : 'Custom'}
        </Badge>
      ),
    },
    {
      accessorKey: 'quotaBytes',
      header: 'Quota',
      meta: { label: 'Quota' },
      cell: ({ row }) =>
        row.original.quotaBytes != null ? (
          <span className="tabular-nums">{formatBytes(row.original.quotaBytes)}</span>
        ) : (
          <span className="text-muted-foreground">{'\u2014'}</span>
        ),
    },
    {
      accessorKey: 'resourceStatus',
      header: 'Status',
      meta: { label: 'Status' },
      cell: ({ row }) => <ResourceStatusBadge status={row.original.resourceStatus} />,
    },
    {
      accessorKey: 'updatedAt',
      header: 'Updated',
      meta: { label: 'Updated' },
      cell: ({ row }) => <span className="text-muted-foreground">{formatRelativeTime(row.original.updatedAt)}</span>,
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      meta: { label: 'Actions' },
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      size: 56,
      minSize: 56,
      cell: ({ row }) => (
        <div className="flex w-full justify-end">
          <BucketRowActions
            bucket={row.original}
            onBrowse={() => setBrowsing(row.original)}
            onDelete={() => setDeleting(row.original)}
            deleteBlockedReason={deleteBlockedReason(row.original, scoped, tenantNames, elevated)}
          />
        </div>
      ),
    },
  ];

  // No buckets at all → provision CTA; buckets exist but the search hides them → filtered-empty.
  const emptyState =
    buckets.length === 0 ? (
      <EmptyState
        icon={IconBucket}
        title="No buckets provisioned yet"
        description="Buckets are created automatically on first upload, or provision the standard set for a tenant."
        action={
          <Button onClick={onProvision}>
            <IconDatabase aria-hidden />
            Provision buckets
          </Button>
        }
      />
    ) : (
      <EmptyState icon={IconFilterOff} title="No buckets match your filters" description="Try a different search term or clear the active filters." />
    );

  function handleDeleteConfirmed() {
    if (!deleting) return;
    deleteBucket.mutate(deleting.id, {
      onSuccess: () => {
        toast.success('Bucket deleted');
        setDeleting(null);
      },
      onError: (mutationError) => {
        toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not delete the bucket.');
        setDeleting(null);
      },
    });
  }

  return (
    <>
      <VirtualizedDataGrid<TenantBucket>
        aria-label="Tenant buckets"
        columns={columns}
        data={buckets}
        getRowId={(row) => row.id}
        persistence={gridPersistence('tenant-storage-buckets')}
        features={{
          columnReorder: true,
          columnResize: true,
          columnPinning: true,
          columnVisibility: true,
          rowSelection: false,
          globalSearch: true,
          facetedFilters: true,
          sorting: true,
        }}
        isLoading={isLoading}
        error={error}
        onRetry={() => refetch()}
        errorState={(err) => <ErrorState error={err} onRetry={() => refetch()} />}
        emptyState={emptyState}
        onRowClick={(row) => setBrowsing(row)}
      />
      <BucketBrowserSheet bucket={browsing} onOpenChange={(open) => !open && setBrowsing(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete bucket?"
        description={deleting ? `This permanently deletes ${deleting.name} and its contents become unreachable. This cannot be undone.` : ''}
        confirmLabel="Delete bucket"
        destructive
        typeToConfirm={deleting?.slug}
        onConfirm={handleDeleteConfirmed}
        isPending={deleteBucket.isPending}
      />
    </>
  );
}

/** Provisions the standard system buckets for an explicit tenant id. */
function ProvisionBucketsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const provision = useProvisionTenantBuckets();
  const [tenantId, setTenantId] = useState('');

  function handleOpenChange(next: boolean) {
    if (!next) {
      setTenantId('');
      provision.reset();
    }
    onOpenChange(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    provision.mutate(tenantId.trim(), {
      onSuccess: (buckets) => {
        toast.success(`${formatNumber(buckets.length)} buckets provisioned`);
        handleOpenChange(false);
      },
      onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not provision the buckets.'),
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Provision tenant buckets</DialogTitle>
          <DialogDescription>
            Creates the standard system buckets (attachments, recordings) for the tenant if they are missing. Existing buckets are left untouched.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="provision-tenant-id">
              Tenant ID
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <Input
              id="provision-tenant-id"
              value={tenantId}
              onChange={(event) => setTenantId(event.target.value)}
              placeholder="Tenant UUID from the Tenants list"
              className="font-mono"
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={provision.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!tenantId.trim() || provision.isPending}>
              {provision.isPending ? <Spinner /> : null}
              Provision
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Adopts an EXISTING physical bucket into a tenant (`POST .../buckets/register`).
 *
 * This is the destination of the storage browser's "Register" action: that
 * screen lists physical MinIO buckets an unscoped platform admin can see, and
 * an unregistered one is invisible here until a `TenantBucket` row exists for
 * it — which is precisely what this dialog creates. The bucket name arrives in
 * `?register=<name>` so the operator does not have to retype it.
 *
 * The tenant is picked explicitly rather than inherited: the screen that
 * links here is unscoped by definition (no working tenant), so there is no
 * ambient owner. Registry-only — the bucket itself is never touched.
 *
 * Seeded from `initialName` on mount; the caller remounts via `key` when the
 * deep link names a different bucket.
 */
function RegisterBucketDialog({
  open,
  initialName,
  platform,
  onOpenChange,
}: {
  open: boolean;
  initialName: string;
  /** The deep link named a PLATFORM bucket — the owner is forced to System. */
  platform: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const adopt = useAdoptBucket();
  const tenantCatalog = useTenantCatalog();
  const [name, setName] = useState(initialName);
  // TASK-967 — a platform bucket is owned by the SYSTEM tenant and by nothing
  // else, so the owner is preselected AND the control is locked rather than
  // left as a choice whose only other answers the gateway will refuse.
  const [tenantId, setTenantId] = useState(platform ? SYSTEM_TENANT_ID : '');
  const [description, setDescription] = useState('');

  const tenants = tenantCatalog.data ?? [];

  function handleOpenChange(next: boolean) {
    if (!next) {
      setTenantId(platform ? SYSTEM_TENANT_ID : '');
      setDescription('');
      adopt.reset();
    }
    onOpenChange(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    adopt.mutate(
      { name: name.trim(), tenantId, description: description.trim() || undefined },
      {
        onSuccess: (bucket) => {
          toast.success(`${bucket.name} registered`);
          handleOpenChange(false);
        },
        onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not register the bucket.'),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Register existing bucket</DialogTitle>
          <DialogDescription>
            {platform
              ? 'Registers a platform bucket so it can be managed from this console. It is owned by the platform, never by a customer tenant, so the owner is fixed to System. The bucket and its contents are left untouched.'
              : 'Registers a bucket that already exists in storage so a tenant owns it. The bucket and its contents are left untouched.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="register-bucket-name">
              Bucket name
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <Input
              id="register-bucket-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Physical bucket name, exactly as storage reports it"
              className="font-mono"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="register-bucket-tenant">
              Owning tenant
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <Select value={tenantId} onValueChange={setTenantId} disabled={platform}>
              <SelectTrigger id="register-bucket-tenant" className="w-full">
                <SelectValue placeholder={tenantCatalog.isPending ? 'Loading tenants…' : 'Select a tenant'} />
              </SelectTrigger>
              <SelectContent>
                {tenants.map((tenant) => (
                  <SelectItem key={tenant.id} value={tenant.id}>
                    {tenant.name || tenant.key || tenant.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* A disabled control needs a visible reason (UX principles §5) —
                adjacent text, not a tooltip, which a disabled trigger never fires. */}
            {platform ? (
              <p className="text-muted-foreground text-sm">
                This is a platform bucket (model weights, MLflow artifacts, backups, the workflow claim check), so the System tenant owns it.
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="register-bucket-description">Description</Label>
            <Input
              id="register-bucket-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={adopt.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || !tenantId || adopt.isPending}>
              {adopt.isPending ? <Spinner /> : null}
              Register
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Frame 14 — Tenant storage administration: buckets, defaults, configs, keys. */
/**
 * The buckets list works CROSS-TENANT for an unscoped elevated
 * session (SUPER_ADMIN with no working tenant): the backend returns every
 * tenant's buckets and the grid shows a Tenant column + filter. Defaults and
 * access keys remain per-tenant wiring, so those tabs still ask for a working
 * tenant when the session is unscoped; Configs shows the PLATFORM storage
 * default instead, since that is the scope an unscoped platform admin is in.
 */
export function TenantStorageScreen() {
  const session = useSession();

  // Don't mount the data tabs until the scope is known.
  if (!session.data) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Tenant Storage Administration" meta={<Skeleton className="h-4 w-40" />} />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const scoped = !session.data.isElevated || Boolean(session.data.workingTenantId);
  // TASK-967 — platform-bucket deletion is a platform-admin act, independent of
  // whether a working tenant happens to be selected, so it needs the elevation
  // bit in its own right rather than inferring it from `scoped`.
  return <StorageScreenBody scoped={scoped} elevated={session.data.isElevated} />;
}

/** Per-tenant tabs (defaults / configs / keys) still need a working tenant. */
function PickTenantState() {
  return (
    <EmptyState
      icon={IconBuilding}
      title="Select a working tenant"
      description="This section is administered per tenant. Pick a working tenant from the switcher in the top bar to load it."
    />
  );
}

function StorageScreenBody({ scoped, elevated }: { scoped: boolean; elevated: boolean }) {
  const bucketsQuery = useBuckets();
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('buckets'));
  const [provisionOpen, setProvisionOpen] = useState(false);
  // `?register=<bucket>` is the storage browser's deep link (frame 31 → here).
  // A non-empty value opens the dialog prefilled; clearing the param closes
  // it, so the URL stays the single source of truth and a browser Back
  // dismisses the dialog rather than stranding it.
  const [registerParam, setRegisterParam] = useQueryState('register', parseAsString.withDefault(''));
  // TASK-967 — `&platform=1` rides along when the deep link names a PLATFORM
  // bucket. The console cannot classify a bucket name itself (`isPlatformBucket`
  // lives in `@arcaai/domains`, a backend package the console does not depend
  // on), so the flag carries the GATEWAY's own classification from the storage
  // browser's listing rather than being re-derived here, where it could drift.
  // It only changes what the dialog offers — the gateway enforces regardless,
  // so a hand-typed URL without it is still refused.
  const [registerPlatformParam, setRegisterPlatformParam] = useQueryState('platform', parseAsString.withDefault(''));
  const [manualRegisterOpen, setManualRegisterOpen] = useState(false);

  const registerOpen = Boolean(registerParam) || manualRegisterOpen;

  function setRegisterOpen(next: boolean) {
    if (!next) {
      setManualRegisterOpen(false);
      if (registerPlatformParam) void setRegisterPlatformParam(null);
      if (registerParam) void setRegisterParam(null);
      return;
    }
    setManualRegisterOpen(true);
  }

  const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'buckets';
  const buckets = bucketsQuery.data ?? [];
  const totalQuota = buckets.reduce((sum, bucket) => sum + (bucket.quotaBytes ?? 0), 0);

  return (
    <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => setTabParam(next === 'buckets' ? null : next)}>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="Tenant Storage Administration"
            meta={
              <>
                {bucketsQuery.data ? (
                  <span>
                    {formatNumber(buckets.length)} buckets {'\u00b7'} {formatBytes(totalQuota)} quota
                  </span>
                ) : (
                  <Skeleton className="h-4 w-40" />
                )}
              </>
            }
            actions={
              <>
                <Button variant="outline" onClick={() => setRegisterOpen(true)}>
                  <IconPlugConnected aria-hidden />
                  Register existing
                </Button>
                <Button variant="outline" onClick={() => setProvisionOpen(true)}>
                  <IconDatabase aria-hidden />
                  Provision buckets
                </Button>
              </>
            }
          />
        }
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="buckets">Buckets</TabsTrigger>
            <TabsTrigger value="defaults">Defaults</TabsTrigger>
            <TabsTrigger value="configs">Configs</TabsTrigger>
            <TabsTrigger value="keys">Access keys</TabsTrigger>
          </TabsList>
        }
        footer={
          <StatusFooter
            start={<span>{bucketsQuery.isFetching && !bucketsQuery.isLoading ? 'Refreshing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/tenants/storage/buckets
              </span>
            }
          />
        }
      >
        <TabsContent value="buckets" className="flex min-h-0 flex-col">
          <BucketsTab onProvision={() => setProvisionOpen(true)} scoped={scoped} elevated={elevated} />
        </TabsContent>
        <TabsContent value="defaults" className="overflow-y-auto">
          {scoped ? <BucketDefaultsTab /> : <PickTenantState />}
        </TabsContent>
        <TabsContent value="configs" className="overflow-y-auto">
          {/* Unscoped is always elevated here: with no working tenant the scope IS the platform (TASK-984). */}
          {scoped ? <StorageConfigsTab /> : <PlatformStorageDefaultPanel />}
        </TabsContent>
        <TabsContent value="keys" className="overflow-y-auto">
          {scoped ? <AccessKeysTab /> : <PickTenantState />}
        </TabsContent>
      </ScreenTemplate>
      <ProvisionBucketsDialog open={provisionOpen} onOpenChange={setProvisionOpen} />
      {/*
        `key` remounts the dialog whenever the deep-linked bucket changes, so
        `useState(initialName)` seeds the name field correctly on every open
        without an effect syncing prop → state (react-hooks/set-state-in-effect).
        It also clears tenant/description between opens for free.
      */}
      <RegisterBucketDialog
        key={registerParam}
        open={registerOpen}
        initialName={registerParam}
        platform={Boolean(registerParam) && registerPlatformParam === '1'}
        onOpenChange={setRegisterOpen}
      />
    </Tabs>
  );
}
