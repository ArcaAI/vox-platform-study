import { Main } from '@/components/layout/main';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { type MultiColumnConfig, type MultiColumnContentConfig, MultiColumnLayout, type MultiColumnState } from '@arcaai/ui/multi-column-layout';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Separator } from '@arcaai/ui/separator';
import type { ColumnDef } from '@tanstack/react-table';
import { Building2, FolderPlus, Grid3X3, KeyRound, List, Loader2, Plus, Settings2, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  type TenantBucketObject,
  useCreateTenantBucket,
  useCreateTenantFolder,
  useDeleteTenantBucket,
  useTenantBucketObjects,
  useTenantBuckets,
  useTenantBucketTree,
  useUploadTenantObject,
} from '../api/tenant-storage';
import { type Tenant, useTenantsInfinite } from '../api/tenants';
import { AdminDataTable, ConfirmDialog, StatusBadge } from '../components';
import { FolderTreeView } from '../components/folder-tree-view';
import { AccessKeysPanel } from './access-keys-panel';
import { ObjectActions } from './object-actions';
import { ProviderConfigPanel } from './provider-config-panel';

const PAGE_SIZE = 50;

function formatDate(date?: string) {
  if (!date) return '—';
  return new Date(date).toLocaleString();
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** idx).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

/**
 * @param scopedTenantId  TASK-328 A2 — when provided (tenant-detail tab), the
 *   page is locked to this tenant: the tenant picker column is hidden and the
 *   tenant fetch is disabled. Composes the same view without forking it.
 * @param embedded  Render bare (no `<Main>` / page title) for use inside a tab.
 */
export default function StorageManagementPage({ scopedTenantId, embedded }: { scopedTenantId?: string; embedded?: boolean } = {}) {
  const roles = useAuthStore((s: { user?: { roles?: string[] } | null }) => s.user?.roles ?? []);
  const tenantId = useAuthStore((s: { tenantId: string }) => s.tenantId);
  const tenantName = useAuthStore((s: { tenantName: string }) => s.tenantName);
  const isSuperAdmin = roles.includes('SUPER_ADMIN');

  // When locked to a tenant (embedded tab), never show the tenant picker.
  const showTenantsColumn = !scopedTenantId;

  const [tenantSearch, setTenantSearch] = useState('');
  const [selectedTenantId, setSelectedTenantId] = useState<string>(tenantId || '');
  const [bucketSearch, setBucketSearch] = useState('');
  const [bucketSort, setBucketSort] = useState<'name' | 'created' | 'updated'>('name');
  const [selectedBucketId, setSelectedBucketId] = useState<string>('');
  const [selectedFolderPath, setSelectedFolderPath] = useState('');
  const [objectSearch, setObjectSearch] = useState('');
  const [objectSort, setObjectSort] = useState<'name' | 'updated'>('updated');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [createBucketOpen, setCreateBucketOpen] = useState(false);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [newBucketSlug, setNewBucketSlug] = useState('');
  const [newBucketDescription, setNewBucketDescription] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [visibleBucketCount, setVisibleBucketCount] = useState(PAGE_SIZE);
  const [visibleObjectCount, setVisibleObjectCount] = useState(PAGE_SIZE);
  const [providerConfigOpen, setProviderConfigOpen] = useState(false);
  const [accessKeysOpen, setAccessKeysOpen] = useState(false);
  const [deleteBucketOpen, setDeleteBucketOpen] = useState(false);

  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadFolderInputRef = useRef<HTMLInputElement>(null);

  const {
    data: tenantsPages,
    isLoading: tenantsLoading,
    hasNextPage: tenantsHasMore,
    fetchNextPage: fetchNextTenants,
    isFetchingNextPage: tenantsLoadingMore,
    refetch: refetchTenants,
  } = useTenantsInfinite(25, {
    enabled: isSuperAdmin && showTenantsColumn,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const tenantList = useMemo<Tenant[]>(() => {
    if (!isSuperAdmin) {
      if (!tenantId) return [];
      return [
        {
          id: tenantId,
          name: tenantName || tenantId,
          key: tenantId,
          resourceStatus: 'ENABLED',
          createdAt: '',
          updatedAt: '',
        } as Tenant,
      ];
    }
    return tenantsPages?.pages.flatMap((page) => page.data) ?? [];
  }, [isSuperAdmin, tenantId, tenantName, tenantsPages]);

  const filteredTenants = useMemo(
    () => tenantList.filter((item) => `${item.name} ${item.key}`.toLowerCase().includes(tenantSearch.toLowerCase())),
    [tenantList, tenantSearch],
  );

  const effectiveTenantId = scopedTenantId ?? (isSuperAdmin ? selectedTenantId : tenantId);
  const {
    data: bucketsData = [],
    isLoading: bucketsLoading,
    refetch: refetchBuckets,
  } = useTenantBuckets(effectiveTenantId || '', {
    enabled: !!effectiveTenantId,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const createBucket = useCreateTenantBucket(effectiveTenantId || '');
  const createFolder = useCreateTenantFolder();
  const uploadObject = useUploadTenantObject();
  const deleteBucket = useDeleteTenantBucket(effectiveTenantId || '');

  const selectedBucket = useMemo(() => bucketsData.find((bucket) => bucket.id === selectedBucketId), [bucketsData, selectedBucketId]);

  const { data: bucketTree, refetch: refetchBucketTree } = useTenantBucketTree(effectiveTenantId || '', selectedBucketId, '', {
    enabled: !!effectiveTenantId && !!selectedBucketId,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const {
    data: objects = [],
    isLoading: objectsLoading,
    refetch: refetchObjects,
  } = useTenantBucketObjects(effectiveTenantId || '', selectedBucket?.name || '', selectedFolderPath, {
    enabled: !!effectiveTenantId && !!selectedBucket?.name,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    if (isSuperAdmin) return;
    if (tenantId && tenantId !== selectedTenantId) {
      setSelectedTenantId(tenantId);
    }
  }, [isSuperAdmin, selectedTenantId, tenantId]);

  const filteredBuckets = useMemo(() => {
    const rows = bucketsData.filter((bucket) => `${bucket.slug} ${bucket.name}`.toLowerCase().includes(bucketSearch.toLowerCase()));
    return rows.sort((a, b) => {
      if (bucketSort === 'created') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (bucketSort === 'updated') return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      return a.slug.localeCompare(b.slug);
    });
  }, [bucketSearch, bucketSort, bucketsData]);
  const visibleBuckets = useMemo(() => filteredBuckets.slice(0, visibleBucketCount), [filteredBuckets, visibleBucketCount]);

  const filteredObjects = useMemo(() => {
    const rows = objects.filter((item) => item.key.toLowerCase().includes(objectSearch.toLowerCase()));
    return rows.sort((a, b) => {
      if (objectSort === 'updated') {
        return new Date(b.lastModified ?? 0).getTime() - new Date(a.lastModified ?? 0).getTime();
      }
      return a.key.localeCompare(b.key);
    });
  }, [objects, objectSearch, objectSort]);
  const visibleObjects = useMemo(() => filteredObjects.slice(0, visibleObjectCount), [filteredObjects, visibleObjectCount]);

  useEffect(() => {
    setVisibleBucketCount(PAGE_SIZE);
  }, [bucketSearch, bucketSort, effectiveTenantId]);

  useEffect(() => {
    setVisibleObjectCount(PAGE_SIZE);
  }, [objectSearch, objectSort, selectedBucketId, selectedFolderPath]);

  const objectColumns = useMemo<ColumnDef<TenantBucketObject, unknown>[]>(
    () => [
      {
        accessorKey: 'key',
        header: 'Name',
        cell: ({ row }) => <span className="font-medium">{row.original.key}</span>,
      },
      {
        accessorKey: 'size',
        header: 'Size',
        cell: ({ row }) => formatBytes(row.original.size ?? 0),
      },
      {
        accessorKey: 'lastModified',
        header: 'Updated',
        cell: ({ row }) => formatDate(row.original.lastModified),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) =>
          effectiveTenantId && selectedBucket ? (
            <ObjectActions
              tenantId={effectiveTenantId}
              bucketId={selectedBucket.id}
              bucketName={selectedBucket.name}
              objectKey={row.original.key}
              prefix={selectedFolderPath}
              compact
              onDeleted={() => {
                void refetchObjects();
                void refetchBucketTree();
              }}
            />
          ) : null,
      },
    ],
    [effectiveTenantId, selectedBucket, selectedFolderPath, refetchObjects, refetchBucketTree],
  );

  const loadMoreOnScroll = (event: React.UIEvent<HTMLDivElement>, setCount: React.Dispatch<React.SetStateAction<number>>) => {
    const element = event.currentTarget;
    const nearBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 48;
    if (nearBottom) {
      setCount((prev) => prev + PAGE_SIZE);
    }
  };

  const handleCreateBucket = () => {
    if (!newBucketSlug.trim()) {
      toast.error('Bucket slug is required.');
      return;
    }
    createBucket.mutate(
      { slug: newBucketSlug.trim(), description: newBucketDescription.trim() || undefined },
      {
        onSuccess: () => {
          toast.success('Bucket created.');
          setCreateBucketOpen(false);
          setNewBucketSlug('');
          setNewBucketDescription('');
          void refetchBuckets();
        },
        onError: (error) => toast.error(error.message),
      },
    );
  };

  const handleCreateFolder = () => {
    if (!effectiveTenantId || !selectedBucket) return;
    createFolder.mutate(
      {
        tenantId: effectiveTenantId,
        bucketName: selectedBucket.name,
        folderName: newFolderName,
        path: selectedFolderPath,
      },
      {
        onSuccess: () => {
          toast.success('Folder created.');
          setCreateFolderOpen(false);
          setNewFolderName('');
          void refetchBucketTree();
          void refetchObjects();
        },
        onError: (error) => toast.error(error.message),
      },
    );
  };

  const uploadFiles = (files: FileList | null) => {
    if (!files?.length || !effectiveTenantId || !selectedBucket) return;
    const uploadJobs = Array.from(files).map((file) =>
      uploadObject.mutateAsync({
        tenantId: effectiveTenantId,
        bucketName: selectedBucket.name,
        file,
        fileName: file.name,
        path: selectedFolderPath,
      }),
    );
    void Promise.all(uploadJobs)
      .then(() => {
        toast.success(`Uploaded ${files.length} item(s).`);
        void refetchBucketTree();
        void refetchObjects();
      })
      .catch((error: Error) => toast.error(error.message));
  };

  const handleDeleteBucket = () => {
    if (!selectedBucket) return;
    deleteBucket.mutate(selectedBucket.id, {
      onSuccess: () => {
        toast.success('Bucket deleted.');
        setDeleteBucketOpen(false);
        setSelectedBucketId('');
        setSelectedFolderPath('');
        void refetchBuckets();
      },
      onError: (error: Error) => toast.error(error.message),
    });
  };

  const handleTenantSelect = useCallback(
    (id: string) => {
      if (!isSuperAdmin) return;
      if (id === selectedTenantId) return;
      setSelectedTenantId(id);
      setSelectedBucketId('');
      setSelectedFolderPath('');
    },
    [isSuperAdmin, selectedTenantId],
  );

  const handleBucketSelect = useCallback(
    (id: string) => {
      if (id === selectedBucketId) return;
      setSelectedBucketId(id);
      setSelectedFolderPath('');
    },
    [selectedBucketId],
  );

  const handleFolderSelect = useCallback(
    (path: string) => {
      if (path === selectedFolderPath) return;
      setSelectedFolderPath(path);
    },
    [selectedFolderPath],
  );

  const tenantsColumn: MultiColumnConfig<Tenant> = {
    id: 'storage-tenants',
    title: 'Tenants',
    subtitle: 'Select tenant',
    width: '220px',
    showItemCount: true,
    keyExtractor: (item: Tenant) => item.id,
    estimateItemSize: 62,
    onRefresh: () => {
      if (!isSuperAdmin) return;
      void refetchTenants();
    },
    headerControls: (
      <Input
        value={tenantSearch}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTenantSearch(event.target.value)}
        placeholder="Search tenant..."
      />
    ),
    emptyTitle: 'No tenants',
    emptyDescription: 'No tenant matched your search.',
    emptyIcon: <Building2 className="size-4" />,
    renderItem: (item: Tenant) => (
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{item.name}</p>
          <p className="text-muted-foreground truncate text-xs">{item.key}</p>
        </div>
        <StatusBadge status={item.resourceStatus ?? 'ENABLED'} />
      </div>
    ),
  };

  const tenantsState: MultiColumnState<Tenant> = {
    data: filteredTenants,
    isLoading: tenantsLoading,
    selectedId: isSuperAdmin ? selectedTenantId : tenantId,
    onSelect: handleTenantSelect,
    hasMore: !!tenantsHasMore,
    onLoadMore: () => fetchNextTenants(),
    isLoadingMore: tenantsLoadingMore,
  };

  const bucketsColumn: MultiColumnContentConfig = {
    type: 'content',
    id: 'storage-buckets',
    title: 'Buckets & Folders',
    subtitle: effectiveTenantId ? `${filteredBuckets.length} bucket(s)` : 'Select tenant',
    width: '340px',
    onRefresh: () => {
      if (!effectiveTenantId) return;
      void refetchBuckets();
      if (selectedBucketId) {
        void refetchBucketTree();
      }
      if (selectedBucket?.name) {
        void refetchObjects();
      }
    },
    renderContent: () => (
      <div className="flex h-full flex-col gap-3 p-3">
        <div className="flex items-center gap-2">
          <Input
            value={bucketSearch}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setBucketSearch(event.target.value)}
            placeholder="Search bucket..."
          />
          <Select value={bucketSort} onValueChange={(value: 'name' | 'created' | 'updated') => setBucketSort(value)}>
            <SelectTrigger className="w-34">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="created">Created</SelectItem>
              <SelectItem value="updated">Updated</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setCreateBucketOpen(true)}>
            <Plus data-icon="inline-start" />
            Bucket
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCreateFolderOpen(true)} disabled={!selectedBucket}>
            <FolderPlus data-icon="inline-start" />
            Subfolder
          </Button>
        </div>
        <div
          className="grid max-h-56 gap-2 overflow-auto"
          onScroll={(event: React.UIEvent<HTMLDivElement>) => loadMoreOnScroll(event, setVisibleBucketCount)}
        >
          {bucketsLoading ? (
            <div className="text-muted-foreground text-sm">Loading buckets...</div>
          ) : (
            visibleBuckets.map((bucket) => (
              <button
                key={bucket.id}
                type="button"
                className={cn(
                  'hover:bg-muted flex items-center justify-between rounded-md border px-2 py-2 text-left',
                  selectedBucketId === bucket.id && 'bg-muted',
                )}
                onClick={() => {
                  handleBucketSelect(bucket.id);
                }}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{bucket.slug}</p>
                  <p className="text-muted-foreground truncate text-xs">{bucket.name}</p>
                </div>
                <Badge variant="outline">{bucket.bucketType}</Badge>
              </button>
            ))
          )}
        </div>
        {visibleBuckets.length < filteredBuckets.length && (
          <Button variant="outline" size="sm" onClick={() => setVisibleBucketCount((prev) => prev + PAGE_SIZE)}>
            Load More
          </Button>
        )}
        <Separator />
        <div className="min-h-0 flex-1 overflow-hidden">
          <FolderTreeView nodes={bucketTree?.nodes ?? []} selectedPath={selectedFolderPath} onSelect={(node) => handleFolderSelect(node.path)} />
        </div>
      </div>
    ),
  };

  const bucketsState: MultiColumnState<never> = {
    data: [],
    isLoading: false,
    selectedId: null,
    onSelect: () => {},
    enabled: !!effectiveTenantId,
  };

  const objectsColumn: MultiColumnContentConfig = {
    type: 'content',
    id: 'storage-objects',
    title: 'Blobs',
    subtitle: selectedBucket ? `${selectedBucket.slug} / ${selectedFolderPath || 'root'}` : 'Select bucket',
    width: '1fr',
    onRefresh: () => {
      if (!selectedBucket?.name) return;
      void refetchObjects();
    },
    renderContent: () => (
      <div className="flex h-full flex-col gap-3 p-3">
        <div className="flex items-center gap-2">
          <Input
            value={objectSearch}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setObjectSearch(event.target.value)}
            placeholder="Search object..."
          />
          <Select value={objectSort} onValueChange={(value: 'name' | 'updated') => setObjectSort(value)}>
            <SelectTrigger className="w-34">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="updated">Updated</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => setViewMode((prev) => (prev === 'list' ? 'grid' : 'list'))}>
            {viewMode === 'list' ? <Grid3X3 /> : <List />}
          </Button>
          <Button size="sm" onClick={() => uploadInputRef.current?.click()} disabled={!selectedBucket || uploadObject.isPending}>
            {uploadObject.isPending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Upload data-icon="inline-start" />}
            Upload Files
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => uploadFolderInputRef.current?.click()}
            disabled={!selectedBucket || uploadObject.isPending}
          >
            <Upload data-icon="inline-start" />
            Upload Folder
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setDeleteBucketOpen(true)}
            disabled={!selectedBucket || selectedBucket.isSystemBucket || deleteBucket.isPending}
            title={selectedBucket?.isSystemBucket ? 'System buckets cannot be deleted' : 'Delete bucket'}
          >
            <Trash2 data-icon="inline-start" />
            Delete Bucket
          </Button>
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="hidden"
            title="Upload files"
            aria-label="Upload files"
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              uploadFiles(event.target.files);
              event.currentTarget.value = '';
            }}
          />
          <input
            ref={uploadFolderInputRef}
            type="file"
            multiple
            className="hidden"
            title="Upload folder"
            aria-label="Upload folder"
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              uploadFiles(event.target.files);
              event.currentTarget.value = '';
            }}
          />
        </div>
        {viewMode === 'list' ? (
          <div className="flex flex-col gap-2">
            <AdminDataTable data={visibleObjects} columns={objectColumns} isLoading={objectsLoading} emptyMessage="No blobs found." />
            {visibleObjects.length < filteredObjects.length && (
              <Button variant="outline" size="sm" onClick={() => setVisibleObjectCount((prev) => prev + PAGE_SIZE)}>
                Load More
              </Button>
            )}
          </div>
        ) : (
          <div
            className="grid grid-cols-1 gap-2 overflow-auto sm:grid-cols-2 lg:grid-cols-3"
            onScroll={(event: React.UIEvent<HTMLDivElement>) => loadMoreOnScroll(event, setVisibleObjectCount)}
          >
            {visibleObjects.map((item) => (
              <div key={item.key} className="flex flex-col gap-1 rounded-md border p-3">
                <p className="truncate text-sm font-medium">{item.key}</p>
                <p className="text-muted-foreground text-xs">{formatBytes(item.size ?? 0)}</p>
                <p className="text-muted-foreground text-xs">{formatDate(item.lastModified)}</p>
                {effectiveTenantId && selectedBucket && (
                  <div className="mt-1 border-t pt-1">
                    <ObjectActions
                      tenantId={effectiveTenantId}
                      bucketId={selectedBucket.id}
                      bucketName={selectedBucket.name}
                      objectKey={item.key}
                      prefix={selectedFolderPath}
                      onDeleted={() => {
                        void refetchObjects();
                        void refetchBucketTree();
                      }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  };

  const objectsState: MultiColumnState<never> = {
    data: [],
    isLoading: false,
    selectedId: null,
    onSelect: () => {},
    enabled: !!selectedBucket,
  };

  const storageActions = (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => setProviderConfigOpen(true)} disabled={!effectiveTenantId}>
        <Settings2 data-icon="inline-start" />
        Provider Config
      </Button>
      <Button variant="outline" size="sm" onClick={() => setAccessKeysOpen(true)} disabled={!effectiveTenantId}>
        <KeyRound data-icon="inline-start" />
        Access Keys
      </Button>
    </div>
  );

  const dialogs = (
    <>
      <Dialog open={createBucketOpen} onOpenChange={setCreateBucketOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Bucket</DialogTitle>
            <DialogDescription>Create a tenant custom bucket.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              placeholder="bucket slug"
              value={newBucketSlug}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setNewBucketSlug(event.target.value)}
            />
            <Input
              placeholder="description (optional)"
              value={newBucketDescription}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setNewBucketDescription(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateBucketOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateBucket} disabled={createBucket.isPending}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createFolderOpen} onOpenChange={setCreateFolderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Subfolder</DialogTitle>
            <DialogDescription>
              Create a folder in <span className="font-medium">{selectedFolderPath || 'root'}</span>.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="folder-name"
            value={newFolderName}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setNewFolderName(event.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateFolderOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateFolder} disabled={createFolder.isPending}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={providerConfigOpen} onOpenChange={setProviderConfigOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Storage Provider Configuration</DialogTitle>
            <DialogDescription>Configure the storage backend and default buckets for this tenant.</DialogDescription>
          </DialogHeader>
          {effectiveTenantId ? (
            <ProviderConfigPanel tenantId={effectiveTenantId} buckets={bucketsData} />
          ) : (
            <p className="text-muted-foreground text-sm">Select a tenant first.</p>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={accessKeysOpen} onOpenChange={setAccessKeysOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Storage Access Keys</DialogTitle>
            <DialogDescription>Manage programmatic access keys for this tenant&apos;s storage.</DialogDescription>
          </DialogHeader>
          {effectiveTenantId ? (
            <AccessKeysPanel tenantId={effectiveTenantId} />
          ) : (
            <p className="text-muted-foreground text-sm">Select a tenant first.</p>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteBucketOpen}
        onOpenChange={setDeleteBucketOpen}
        title="Delete bucket?"
        description={`This permanently removes the bucket "${selectedBucket?.slug ?? ''}" and its storage container. This action cannot be undone.`}
        confirmLabel="Delete bucket"
        variant="destructive"
        isLoading={deleteBucket.isPending}
        onConfirm={handleDeleteBucket}
      />
    </>
  );

  const layout = (
    <MultiColumnLayout
      columns={[...(showTenantsColumn ? [tenantsColumn] : []), bucketsColumn, objectsColumn]}
      columnStates={[...(showTenantsColumn ? [tenantsState] : []), bucketsState, objectsState]}
      height={embedded ? 'calc(100vh - 20rem)' : 'calc(100vh - 12rem)'}
    />
  );

  // TASK-328 A2 — embedded inside the tenant-detail "Storage" tab: render bare.
  if (embedded) {
    return (
      <div className="space-y-3">
        <div className="flex justify-end">{storageActions}</div>
        {layout}
        {dialogs}
      </div>
    );
  }

  return (
    <Main>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Storage Management</h2>
          <p className="text-muted-foreground mt-1">Manage tenant buckets, folder tree, and blob objects via admin APIs.</p>
        </div>
        {storageActions}
      </div>
      {layout}
      {dialogs}
    </Main>
  );
}
