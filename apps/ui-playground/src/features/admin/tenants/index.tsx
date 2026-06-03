import { zodResolver } from '@/lib/zod-resolver';
import type { ColumnDef, PaginationState, RowSelectionState } from '@tanstack/react-table';
import {
  Ban,
  Building2,
  Calendar,
  Check,
  CheckCircle,
  ChevronRight,
  Eye,
  FileText,
  FolderTree,
  HardDrive,
  Layers,
  Loader2,
  LogIn,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RotateCcw,
  ScrollText,
  Settings,
  Settings2,
  Shield,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { DEFAULT_PAGE_SIZE } from '@arcaai/vox';

import { Main } from '@/components/layout/main';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import PromptManagementPage from '@/features/admin/prompts';
import StorageManagementPage from '@/features/admin/storage';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Checkbox } from '@arcaai/ui/checkbox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@arcaai/ui/dropdown-menu';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@arcaai/ui/form';
import { Input } from '@arcaai/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Separator } from '@arcaai/ui/separator';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Textarea } from '@arcaai/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@arcaai/ui/tooltip';

import { MultiColumnLayout, type MultiColumnConfig, type MultiColumnContentConfig, type MultiColumnState } from '@arcaai/ui/multi-column-layout';
import { AdminDataTable, ConfirmDialog, SearchFilterBar, StatusBadge } from '../components';

import { useTenantAuditLogs, type AuditLog } from '../api/audit-logs';
import {
  useCreateTenantDepartment,
  useDeleteTenantDepartment,
  useTenantDepartments,
  useUpdateTenantDepartment,
  useUpdateTenantDepartmentPromptConfig,
  type Department,
} from '../api/departments';
import { usePromptTemplates, type PromptTemplate } from '../api/prompts';
import {
  useCreateTenant,
  useDeleteTenant,
  useTenant,
  useTenantConfigs,
  useTenantsInfinite,
  useTenantUsage,
  useToggleTenantStatus,
  useUpdateTenantConfigs,
  type Tenant,
  type TenantConfig,
} from '../api/tenants';
import {
  useAdminUsersByTenant,
  useCreateUser,
  useDeleteUser,
  useUpdateUser,
  useUpdateUserStatus,
  type AdminUser,
  type CreateUserInput,
} from '../api/users';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const TENANT_STATUS_OPTIONS = [
  { value: '_all', label: 'All Statuses' },
  { value: 'ENABLED', label: 'Enabled' },
  { value: 'DISABLED', label: 'Disabled' },
  { value: 'ARCHIVED', label: 'Archived' },
];

const USER_STATUS_OPTIONS = [
  { value: '_all', label: 'All Statuses' },
  { value: 'ENABLED', label: 'Enabled' },
  { value: 'DISABLED', label: 'Disabled' },
];

const AUDIT_ACTION_OPTIONS = [
  { value: '_all', label: 'All Actions' },
  { value: 'CREATE', label: 'Create' },
  { value: 'UPDATE', label: 'Update' },
  { value: 'DELETE', label: 'Delete' },
  { value: 'LOGIN', label: 'Login' },
];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createTenantSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  key: z
    .string()
    .min(1, 'Key is required')
    .regex(/^[a-z0-9-]+$/, 'Lowercase alphanumeric and hyphens only'),
  description: z.string().optional(),
});

type CreateTenantFormValues = z.infer<typeof createTenantSchema>;

const tenantUserSchema = z.object({
  username: z.string().min(1, 'Username is required').max(64),
  email: z.string().email('Invalid email').or(z.literal('')),
  password: z.string().min(6, 'Minimum 6 characters'),
  externalId: z.string(),
  isServiceAccount: z.boolean(),
});

const tenantUserEditSchema = z.object({
  username: z.string().min(1, 'Username is required').max(64),
  email: z.string().email('Invalid email').or(z.literal('')),
  password: z.string().refine((v) => !v || v.length >= 6, 'Minimum 6 characters'),
  externalId: z.string(),
  isServiceAccount: z.boolean(),
});

type TenantUserFormValues = z.infer<typeof tenantUserSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date?: string | Date | null) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Create Tenant Form
// ---------------------------------------------------------------------------

function CreateTenantForm({ onSuccess, onCancel }: { onSuccess: (tenant: Tenant) => void; onCancel: () => void }) {
  const createTenant = useCreateTenant();
  const form = useForm<CreateTenantFormValues>({
    resolver: zodResolver(createTenantSchema),
    defaultValues: { name: '', key: '', description: '' },
  });

  const onSubmit = (values: CreateTenantFormValues) => {
    createTenant.mutate(values, {
      onSuccess: (tenant) => {
        toast.success(`Tenant "${tenant.name}" created`);
        form.reset();
        onSuccess(tenant);
      },
      onError: (err) => {
        toast.error(err.message || 'Failed to create tenant');
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create New Tenant</CardTitle>
        <CardDescription>Fill in the details below to provision a new tenant.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="My Organisation" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="key"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>Key</FormLabel>
                  <FormControl>
                    <Input placeholder="my-org" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Optional description…" className="resize-none" rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" disabled={createTenant.isPending}>
                {createTenant.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Create Tenant
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tenant User Form Dialog (Create / Edit)
// ---------------------------------------------------------------------------

function TenantUserFormDialog({
  open,
  onOpenChange,
  user,
  tenantId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user?: AdminUser | null;
  tenantId: string;
}) {
  const isEdit = !!user;
  const createMut = useCreateUser();
  const updateMut = useUpdateUser();
  const isPending = isEdit ? updateMut.isPending : createMut.isPending;

  const form = useForm<TenantUserFormValues>({
    resolver: zodResolver(isEdit ? tenantUserEditSchema : tenantUserSchema),
    defaultValues: {
      username: '',
      email: '',
      password: '',
      externalId: '',
      isServiceAccount: false,
    },
  });

  React.useEffect(() => {
    if (open) {
      form.reset({
        username: user?.username ?? '',
        email: (user?.email as string) ?? '',
        password: '',
        externalId: user?.externalId ?? '',
        isServiceAccount: user?.isServiceAccount ?? false,
      });
    }
  }, [open, user, form]);

  const onSubmit = (values: TenantUserFormValues) => {
    if (isEdit && user) {
      const payload: Record<string, unknown> = {
        id: user.id,
        username: values.username,
        email: values.email || undefined,
        externalId: values.externalId || null,
        isServiceAccount: values.isServiceAccount,
      };
      if (values.password) payload.password = values.password;
      updateMut.mutate(payload as Parameters<typeof updateMut.mutate>[0], {
        onSuccess: () => {
          toast.success('User updated');
          onOpenChange(false);
        },
        onError: (err) => toast.error(err.message),
      });
    } else {
      const input: CreateUserInput = {
        username: values.username,
        email: values.email || undefined,
        password: values.password,
        externalId: values.externalId || undefined,
        tenantId,
        isServiceAccount: values.isServiceAccount,
      };
      createMut.mutate(input, {
        onSuccess: () => {
          toast.success('User created');
          onOpenChange(false);
        },
        onError: (err) => toast.error(err.message),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit User' : 'Add User'}</DialogTitle>
          <DialogDescription>{isEdit ? 'Update user details.' : 'Add a new user to this tenant.'}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="username"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>Username</FormLabel>
                  <FormControl>
                    <Input placeholder="johndoe" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input placeholder="user@example.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>
                    Password
                    {isEdit && <span className="text-muted-foreground ml-1 text-xs font-normal">(leave blank to keep current)</span>}
                  </FormLabel>
                  <FormControl>
                    <Input type="password" placeholder={isEdit ? '••••••••' : 'Enter password'} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="externalId"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>
                    External ID <span className="text-muted-foreground text-xs font-normal">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="ext-123" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="isServiceAccount"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem className="flex items-center gap-2 space-y-0">
                  <FormControl>
                    <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <FormLabel className="text-sm font-normal">This is a service account</FormLabel>
                </FormItem>
              )}
            />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                {isEdit ? 'Save Changes' : 'Add User'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Users Tab
// ---------------------------------------------------------------------------

function UsersTab({ tenantId, refreshSignal }: { tenantId: string; refreshSignal: number }) {
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('_all');
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [deleteUser, setDeleteUser] = useState<AdminUser | null>(null);

  const {
    data,
    isLoading,
    refetch: refetchUsers,
  } = useAdminUsersByTenant(tenantId, {
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });
  const lastHandledRefreshSignalRef = useRef<number>(refreshSignal);

  useEffect(() => {
    if (refreshSignal === lastHandledRefreshSignalRef.current) {
      return;
    }

    lastHandledRefreshSignalRef.current = refreshSignal;
    void Promise.resolve(refetchUsers()).then((result) => {
      if (result.error) {
        toast.error('Failed to refresh tenant users');
      }
    });
  }, [refreshSignal, refetchUsers]);

  const updateStatus = useUpdateUserStatus();
  const deleteMut = useDeleteUser();

  const filteredData = useMemo(() => {
    let result = data?.data ?? [];
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (u) =>
          u.username.toLowerCase().includes(q) ||
          (u.email && u.email.toLowerCase().includes(q)) ||
          (u.externalId && u.externalId.toLowerCase().includes(q)),
      );
    }
    if (statusFilter !== '_all') {
      result = result.filter((u) => (u.resourceStatus ?? 'ENABLED').toUpperCase() === statusFilter);
    }
    return result;
  }, [data, search, statusFilter]);

  const toggleStatus = useCallback(
    (u: AdminUser) => {
      const current = (u.resourceStatus || 'ENABLED').toUpperCase();
      const next = current === 'ENABLED' ? 'DISABLED' : 'ENABLED';
      updateStatus.mutate(
        { id: u.id, resourceStatus: next },
        {
          onSuccess: () => toast.success(`User ${next === 'ENABLED' ? 'enabled' : 'disabled'}`),
          onError: (err) => toast.error(err.message),
        },
      );
    },
    [updateStatus],
  );

  const handleDelete = useCallback(() => {
    if (!deleteUser) return;
    deleteMut.mutate(deleteUser.id, {
      onSuccess: () => {
        toast.success(`User "${deleteUser.username}" deleted`);
        setDeleteUser(null);
      },
      onError: (err) => toast.error(err.message),
    });
  }, [deleteUser, deleteMut]);

  const columns = useMemo<ColumnDef<AdminUser, unknown>[]>(
    () => [
      {
        accessorKey: 'username',
        header: 'Username',
        cell: ({ row }) => (
          <div>
            <span className="font-medium">{row.original.username}</span>
            {row.original.email && <p className="text-muted-foreground text-xs">{row.original.email}</p>}
          </div>
        ),
      },
      {
        id: 'externalId',
        header: 'External ID',
        cell: ({ row }) => row.original.externalId || '—',
      },
      {
        accessorKey: 'resourceStatus',
        header: 'Status',
        size: 100,
        cell: ({ row }) => <StatusBadge status={row.original.resourceStatus || 'ENABLED'} />,
      },
      {
        id: 'actions',
        header: '',
        size: 48,
        cell: ({ row }) => {
          const u = row.original;
          const enabled = (u.resourceStatus || 'ENABLED').toUpperCase() === 'ENABLED';
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setEditUser(u)}>
                  <Pencil className="mr-2 size-4" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => toggleStatus(u)}>
                  {enabled ? <Ban className="mr-2 size-4" /> : <CheckCircle className="mr-2 size-4" />}
                  {enabled ? 'Disable' : 'Enable'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteUser(u)}>
                  <Trash2 className="mr-2 size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [toggleStatus],
  );

  return (
    <>
      <AdminDataTable
        data={filteredData}
        columns={columns}
        isLoading={isLoading}
        enableRowSelection
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.count ?? 0}
        emptyMessage="No users in this tenant."
        toolbar={
          <SearchFilterBar
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search users…"
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            statusOptions={USER_STATUS_OPTIONS}
          >
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1 size-4" />
              Add User
            </Button>
          </SearchFilterBar>
        }
      />

      <TenantUserFormDialog open={createOpen} onOpenChange={setCreateOpen} tenantId={tenantId} />
      <TenantUserFormDialog
        open={!!editUser}
        onOpenChange={(v) => {
          if (!v) setEditUser(null);
        }}
        user={editUser}
        tenantId={tenantId}
      />
      <ConfirmDialog
        open={!!deleteUser}
        onOpenChange={(v: boolean) => {
          if (!v) setDeleteUser(null);
        }}
        title="Delete User"
        description={`Are you sure you want to delete "${deleteUser?.username}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={deleteMut.isPending}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Configurations Tab
// ---------------------------------------------------------------------------

function ConfigsTab({ tenantIdentifier }: { tenantIdentifier: string }) {
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  });
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  const { data, isLoading } = useTenantConfigs(tenantIdentifier, {
    page: pagination.pageIndex,
    limit: pagination.pageSize,
  });

  const updateConfigs = useUpdateTenantConfigs();

  const filteredData = useMemo(() => {
    if (!search) return data?.data ?? [];
    const q = search.toLowerCase();
    return (data?.data ?? []).filter((c) => c.key.toLowerCase().includes(q) || c.value.toLowerCase().includes(q));
  }, [data, search]);

  const saveConfig = useCallback(
    (cfg: TenantConfig) => {
      // TASK-302 Stream D — CAS predicate from the row version we were editing.
      const expectedVersion = typeof cfg.version === 'number' ? cfg.version : 1;
      updateConfigs.mutate(
        {
          identifier: tenantIdentifier,
          configs: [{ id: cfg.id, value: editingValue, expectedVersion }],
          ifMatch: `"${expectedVersion}"`,
        },
        {
          onSuccess: () => {
            toast.success('Configuration updated');
            setEditingId(null);
          },
          onError: (err) => toast.error(err.message),
        },
      );
    },
    [tenantIdentifier, editingValue, updateConfigs],
  );

  const restoreDefault = useCallback(
    (cfg: TenantConfig) => {
      const expectedVersion = typeof cfg.version === 'number' ? cfg.version : 1;
      updateConfigs.mutate(
        {
          identifier: tenantIdentifier,
          configs: [{ id: cfg.id, value: cfg.defaultValue ?? '', expectedVersion }],
          ifMatch: `"${expectedVersion}"`,
        },
        {
          onSuccess: () => toast.success('Restored to default'),
          onError: (err) => toast.error(err.message),
        },
      );
    },
    [tenantIdentifier, updateConfigs],
  );

  const columns = useMemo<ColumnDef<TenantConfig, unknown>[]>(
    () => [
      {
        id: 'nameKey',
        header: 'Name / Key',
        cell: ({ row }) => (
          <div>
            <span className="text-sm font-medium">{row.original.name}</span>
            <p className="text-muted-foreground font-mono text-xs">
              {row.original.namespace ? `${row.original.namespace}.${row.original.key}` : row.original.key}
            </p>
          </div>
        ),
      },
      {
        id: 'value',
        header: 'Value',
        cell: ({ row }) => {
          const cfg = row.original;
          if (editingId === cfg.id) {
            return (
              <div className="flex items-center gap-1">
                <Input
                  value={editingValue}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditingValue(e.target.value)}
                  className="h-7 text-xs"
                  autoFocus
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') saveConfig(cfg);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
                <Button variant="ghost" size="icon" className="size-7" onClick={() => saveConfig(cfg)} disabled={updateConfigs.isPending}>
                  <Check className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setEditingId(null)}>
                  <X className="size-3.5" />
                </Button>
              </div>
            );
          }
          return <span className="font-mono text-xs">{cfg.value || '—'}</span>;
        },
      },
      {
        id: 'dataType',
        header: 'Type',
        size: 80,
        cell: ({ row }) => (
          <Badge variant="outline" className="text-xs">
            {row.original.dataType || 'String'}
          </Badge>
        ),
      },
      {
        id: 'actions',
        header: '',
        size: 80,
        cell: ({ row }) => {
          const cfg = row.original;
          if (editingId === cfg.id) return null;
          return (
            <div className="flex gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      setEditingId(cfg.id);
                      setEditingValue(cfg.value);
                    }}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit</TooltipContent>
              </Tooltip>
              {cfg.defaultValue != null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        restoreDefault(cfg);
                      }}
                    >
                      <RotateCcw className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Restore default</TooltipContent>
                </Tooltip>
              )}
            </div>
          );
        },
      },
    ],
    [editingId, editingValue, saveConfig, restoreDefault, updateConfigs.isPending],
  );

  return (
    <div className="space-y-3">
      <div className="bg-muted/50 text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
        <Settings2 className="size-3.5 shrink-0" />
        <span>Configurations are provisioned automatically when a tenant is created. Use the row actions to edit values or restore defaults.</span>
      </div>
      <AdminDataTable
        data={filteredData}
        columns={columns}
        isLoading={isLoading}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.count ?? 0}
        emptyMessage="No configurations found."
        toolbar={<SearchFilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search configurations…" />}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit Logs Tab
// ---------------------------------------------------------------------------

function AuditLogsTab({ tenantId }: { tenantId: string }) {
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  });
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('_all');
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  const { data, isLoading } = useTenantAuditLogs(tenantId, {
    page: pagination.pageIndex,
    limit: pagination.pageSize,
    search: search || undefined,
  });

  const filteredData = useMemo(() => {
    let result = data?.data ?? [];
    if (actionFilter !== '_all') {
      result = result.filter((log) => log.action.toUpperCase() === actionFilter);
    }
    return result;
  }, [data, actionFilter]);

  const columns = useMemo<ColumnDef<AuditLog, unknown>[]>(
    () => [
      {
        accessorKey: 'action',
        header: 'Action',
        cell: ({ row }) => (
          <Badge variant="outline" className="text-xs">
            {row.original.action}
          </Badge>
        ),
      },
      {
        id: 'resourceType',
        header: 'Resource Type',
        size: 130,
        cell: ({ row }) => <span className="text-sm">{row.original.resourceType}</span>,
      },
      {
        id: 'responsibleUserId',
        header: 'User',
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.responsibleUserId ? row.original.responsibleUserId.slice(0, 8) + '…' : '—'}</span>
        ),
      },
      {
        accessorKey: 'createdAt',
        header: 'Date',
        cell: ({ row }) => formatDate(row.original.createdAt),
      },
      {
        id: 'success',
        header: 'Result',
        size: 90,
        cell: ({ row }) => {
          const success = row.original.success;
          if (success == null) return '—';
          return (
            <Badge variant="outline" className={cn('text-xs', success ? 'bg-emerald-500/15 text-emerald-700' : 'bg-red-500/15 text-red-700')}>
              {success ? 'Success' : 'Failed'}
            </Badge>
          );
        },
      },
      {
        id: 'view',
        header: '',
        size: 40,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              setSelectedLog(row.original);
            }}
          >
            <Eye className="size-3.5" />
          </Button>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <AdminDataTable
        data={filteredData}
        columns={columns}
        isLoading={isLoading}
        enableRowSelection
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.count ?? filteredData.length}
        emptyMessage="No audit logs for this tenant."
        toolbar={
          <SearchFilterBar
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search audit logs…"
            statusFilter={actionFilter}
            onStatusFilterChange={setActionFilter}
            statusOptions={AUDIT_ACTION_OPTIONS}
          />
        }
      />

      <Dialog
        open={!!selectedLog}
        onOpenChange={(open: boolean) => {
          if (!open) setSelectedLog(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ScrollText className="size-5" />
              Audit Log Detail
            </DialogTitle>
            <DialogDescription>
              {selectedLog?.action} — {formatDate(selectedLog?.createdAt)}
            </DialogDescription>
          </DialogHeader>
          {selectedLog && (
            <div className="space-y-4 text-sm">
              <div className="bg-muted/30 grid grid-cols-2 gap-x-8 gap-y-4 rounded-lg border p-4 sm:grid-cols-3">
                <div>
                  <p className="text-muted-foreground text-xs">Action</p>
                  <div className="mt-1">
                    <Badge variant="outline">{selectedLog.action}</Badge>
                  </div>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Resource Type</p>
                  <p className="mt-1 font-medium">{selectedLog.resourceType}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Result</p>
                  <div className="mt-1">
                    {selectedLog.success == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Badge
                        variant="outline"
                        className={cn('text-xs', selectedLog.success ? 'bg-emerald-500/15 text-emerald-700' : 'bg-red-500/15 text-red-700')}
                      >
                        {selectedLog.success ? 'Success' : 'Failed'}
                      </Badge>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Resource ID</p>
                  <p className="mt-1 font-mono text-xs break-all">{selectedLog.resourceId || '—'}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Responsible User</p>
                  <p className="mt-1 font-mono text-xs break-all">{selectedLog.responsibleUserId || '—'}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Date</p>
                  <p className="mt-1 flex items-center gap-1">
                    <Calendar className="size-3" />
                    {formatDate(selectedLog.createdAt)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Tenant ID</p>
                  <p className="mt-1 font-mono text-xs break-all">{selectedLog.tenantId || '—'}</p>
                </div>
                {selectedLog.eventType && (
                  <div>
                    <p className="text-muted-foreground text-xs">Event Type</p>
                    <p className="mt-1 font-medium">{selectedLog.eventType}</p>
                  </div>
                )}
                {selectedLog.responsibleIp && (
                  <div>
                    <p className="text-muted-foreground text-xs">IP Address</p>
                    <p className="mt-1 font-mono text-xs">{selectedLog.responsibleIp}</p>
                  </div>
                )}
              </div>
              {selectedLog.data != null && (
                <>
                  <Separator />
                  <div>
                    <p className="text-muted-foreground mb-1.5 text-xs font-medium uppercase tracking-wider">Data</p>
                    <pre className="bg-muted max-h-64 overflow-auto rounded-lg border p-4 text-xs leading-relaxed">
                      {JSON.stringify(selectedLog.data, null, 2)}
                    </pre>
                  </div>
                </>
              )}
              {selectedLog.metadata != null && (
                <>
                  <Separator />
                  <div>
                    <p className="text-muted-foreground mb-1.5 text-xs font-medium uppercase tracking-wider">Metadata</p>
                    <pre className="bg-muted max-h-64 overflow-auto rounded-lg border p-4 text-xs leading-relaxed">
                      {JSON.stringify(selectedLog.metadata, null, 2)}
                    </pre>
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Departments Tab — Schemas
// ---------------------------------------------------------------------------

const deptCreateSchema = z.object({
  code: z.string().max(20).optional().or(z.literal('')),
  name: z.string().min(1, 'Department name is required').max(100),
  description: z.string().max(500).optional().or(z.literal('')),
  parentDepartmentId: z.string().optional().or(z.literal('')),
});

const deptEditSchema = z.object({
  code: z.string().max(20).optional().or(z.literal('')),
  name: z.string().min(1, 'Department name is required').max(100),
  description: z.string().max(500).optional().or(z.literal('')),
  parentDepartmentId: z.string().optional().or(z.literal('')),
  defaultSummaryTemplate: z.string().optional().or(z.literal('')),
});

const deptPromptConfigSchema = z.object({
  preSummaryPromptId: z.string().optional().or(z.literal('')),
  newPatientPromptId: z.string().optional().or(z.literal('')),
  revisitPromptId: z.string().optional().or(z.literal('')),
});

type DeptCreateFormValues = z.infer<typeof deptCreateSchema>;
type DeptEditFormValues = z.infer<typeof deptEditSchema>;
type DeptPromptConfigValues = z.infer<typeof deptPromptConfigSchema>;

// ---------------------------------------------------------------------------
// Department Form Dialog (Create / Edit) — for tenant context
// ---------------------------------------------------------------------------

function TenantDeptFormDialog({
  open,
  onOpenChange,
  department,
  departments,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  department?: Department | null;
  departments: Department[];
  isPending: boolean;
  onSubmit: (values: DeptCreateFormValues | DeptEditFormValues) => void;
}) {
  const isEdit = !!department;

  const form = useForm<DeptCreateFormValues | DeptEditFormValues>({
    resolver: zodResolver(isEdit ? deptEditSchema : deptCreateSchema),
    defaultValues: {
      code: '',
      name: '',
      description: '',
      parentDepartmentId: '',
    },
  });

  React.useEffect(() => {
    if (open) {
      form.reset({
        code: department?.code ?? '',
        name: department?.name ?? '',
        description: department?.description ?? '',
        parentDepartmentId: department?.parentDepartmentId ?? '',
        ...(isEdit && {
          defaultSummaryTemplate: department?.defaultSummaryTemplate ?? '',
        }),
      });
    }
  }, [open, department, form, isEdit]);

  const parentOptions = departments.filter((d) => d.id !== department?.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="size-5" />
            {isEdit ? 'Edit Department' : 'Create Department'}
          </DialogTitle>
          <DialogDescription>{isEdit ? 'Update the department details below.' : 'Fill in the details to create a new department.'}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Cardiology" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="code"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>
                    Code
                    <span className="text-muted-foreground ml-1 text-xs font-normal">(optional, unique per tenant)</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. CARD" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>
                    Description
                    <span className="text-muted-foreground ml-1 text-xs font-normal">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea placeholder="Brief description of the department" rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="parentDepartmentId"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>
                    Parent Department
                    <span className="text-muted-foreground ml-1 text-xs font-normal">(optional)</span>
                  </FormLabel>
                  <Select value={field.value || '_none'} onValueChange={(v: string) => field.onChange(v === '_none' ? '' : v)}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="None (root department)" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="_none">None (root department)</SelectItem>
                      {parentOptions.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name || d.code || d.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {isEdit && (
              <FormField
                control={form.control}
                name="defaultSummaryTemplate"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>
                      Default Summary Template
                      <span className="text-muted-foreground ml-1 text-xs font-normal">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. SOAP, Hematology-New" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                {isEdit ? 'Save Changes' : 'Create Department'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Prompt Config Dialog — for tenant context
// ---------------------------------------------------------------------------

function TenantDeptPromptConfigDialog({
  open,
  onOpenChange,
  department,
  prompts,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  department: Department | null;
  prompts: PromptTemplate[];
  isPending: boolean;
  onSubmit: (values: DeptPromptConfigValues) => void;
}) {
  const form = useForm<DeptPromptConfigValues>({
    resolver: zodResolver(deptPromptConfigSchema),
    defaultValues: {
      preSummaryPromptId: '',
      newPatientPromptId: '',
      revisitPromptId: '',
    },
  });

  React.useEffect(() => {
    if (open && department) {
      form.reset({
        preSummaryPromptId: department.preSummaryPromptId ?? '',
        newPatientPromptId: department.newPatientPromptId ?? '',
        revisitPromptId: department.revisitPromptId ?? '',
      });
    }
  }, [open, department, form]);

  const promptOptions = prompts.filter((p) => (p.resourceStatus ?? 'ENABLED').toUpperCase() !== 'DISABLED');

  const renderPromptSelect = (name: 'preSummaryPromptId' | 'newPatientPromptId' | 'revisitPromptId', label: string) => (
    <FormField
      control={form.control}
      name={name}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render={({ field }: { field: any }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select value={field.value || '_none'} onValueChange={(v: string) => field.onChange(v === '_none' ? '' : v)}>
            <FormControl>
              <SelectTrigger>
                <SelectValue placeholder="Not assigned" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              <SelectItem value="_none">Not assigned</SelectItem>
              {promptOptions.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <div className="flex items-center gap-2">
                    <span>{p.name}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {p.category}
                    </Badge>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="size-5" />
            Prompt Configuration
          </DialogTitle>
          <DialogDescription>
            Assign prompt templates to <strong>{department?.name || department?.code || 'this department'}</strong> for different consultation types.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {renderPromptSelect('newPatientPromptId', 'New Patient Prompt')}
            {renderPromptSelect('revisitPromptId', 'Revisit / Follow-up Prompt')}
            {renderPromptSelect('preSummaryPromptId', 'Pre-Summary Prompt')}

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Save Prompt Config
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Department Detail Dialog — for tenant context
// ---------------------------------------------------------------------------

function TenantDeptDetailDialog({
  open,
  onOpenChange,
  department,
  prompts,
  departments,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  department: Department | null;
  prompts: PromptTemplate[];
  departments: Department[];
}) {
  const promptLookup = useMemo(() => {
    const map = new Map<string, PromptTemplate>();
    prompts.forEach((p) => map.set(p.id, p));
    return map;
  }, [prompts]);

  const parentDept = useMemo(() => {
    if (!department?.parentDepartmentId) return null;
    return departments.find((d) => d.id === department.parentDepartmentId);
  }, [department, departments]);

  const renderPromptCard = (label: string, description: string, promptId?: string) => {
    const prompt = promptId ? promptLookup.get(promptId) : undefined;
    const configured = !!promptId;
    return (
      <div
        className={cn('rounded-lg border p-4 transition-colors', configured ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-muted/30 border-dashed')}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold">{label}</p>
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px]',
                  configured ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
                )}
              >
                {configured ? 'Assigned' : 'Not assigned'}
              </Badge>
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
          </div>
        </div>
        {configured && prompt && (
          <div className="mt-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <FileText className="text-muted-foreground size-3.5 shrink-0" />
              <span className="text-sm font-medium">{prompt.name}</span>
              {prompt.category && (
                <Badge variant="secondary" className="text-[10px]">
                  {prompt.category}
                </Badge>
              )}
            </div>
            {prompt.description && <p className="text-muted-foreground line-clamp-2 pl-5.5 text-xs">{prompt.description}</p>}
          </div>
        )}
        {configured && !prompt && (
          <div className="mt-3">
            <p className="text-muted-foreground text-xs italic">
              Prompt template not found (ID: <span className="font-mono">{promptId?.slice(0, 12)}…</span>)
            </p>
          </div>
        )}
      </div>
    );
  };

  const configuredCount = department
    ? [department.newPatientPromptId, department.revisitPromptId, department.preSummaryPromptId].filter(Boolean).length
    : 0;

  const renderPromptConfigKV = (config: Record<string, unknown>) => {
    const entries = Object.entries(config);
    return (
      <div className="space-y-2">
        {entries.map(([key, value]) => (
          <div key={key} className="bg-muted/50 flex items-start gap-3 rounded-md border px-3 py-2">
            <span className="text-muted-foreground shrink-0 font-mono text-xs font-medium">{key}</span>
            <span className="min-w-0 break-all text-xs">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="size-5" />
            Department Details
          </DialogTitle>
          <DialogDescription>Full department information, hierarchy, and prompt template assignments.</DialogDescription>
        </DialogHeader>

        {department ? (
          <div className="-mx-6 flex-1 overflow-y-auto px-6">
            <div className="space-y-6 pb-2">
              <div className="flex items-center gap-4">
                <div className="bg-primary/10 text-primary flex size-14 shrink-0 items-center justify-center rounded-xl">
                  <Building2 className="size-7" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-xl font-semibold">{department.name || 'Unnamed Department'}</h3>
                    <StatusBadge status={String(department.resourceStatus ?? 'ENABLED')} />
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    {department.code && (
                      <Badge variant="secondary" className="font-mono text-xs">
                        {department.code}
                      </Badge>
                    )}
                    <Badge variant="outline" className="text-xs">
                      {department.isRootDepartment ? 'Root Department' : 'Child Department'}
                    </Badge>
                  </div>
                </div>
              </div>

              {department.description && <p className="text-muted-foreground text-sm leading-relaxed">{department.description}</p>}

              <div className="bg-muted/30 grid grid-cols-2 gap-x-8 gap-y-4 rounded-lg border p-5 sm:grid-cols-4">
                <div>
                  <p className="text-muted-foreground text-xs">Created</p>
                  <p className="mt-1 flex items-center gap-1 text-sm font-medium">
                    <Calendar className="size-3" />
                    {formatDate(department.createdAt)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Last Updated</p>
                  <p className="mt-1 flex items-center gap-1 text-sm font-medium">
                    <Calendar className="size-3" />
                    {formatDate(department.updatedAt)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Parent</p>
                  <p className="mt-1 flex items-center gap-1 text-sm font-medium">
                    <FolderTree className="size-3" />
                    {parentDept ? parentDept.name || parentDept.code || 'Unknown' : department.isRootDepartment ? 'None (root)' : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Summary Template</p>
                  <p className="mt-1 flex items-center gap-1 text-sm font-medium">
                    <FileText className="size-3" />
                    {department.defaultSummaryTemplate || 'Default'}
                  </p>
                </div>
              </div>

              <Separator />

              <div>
                <div className="mb-4 flex items-center justify-between">
                  <h4 className="flex items-center gap-2 text-sm font-semibold">
                    <Settings2 className="size-4" />
                    Prompt Template Assignments
                  </h4>
                  <Badge
                    variant="outline"
                    className={cn(
                      'text-xs',
                      configuredCount === 3
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                        : configuredCount > 0
                          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                          : 'bg-red-500/15 text-red-700 dark:text-red-400',
                    )}
                  >
                    {configuredCount}/3 assigned
                  </Badge>
                </div>
                <div className="grid gap-3 sm:grid-cols-1">
                  {renderPromptCard('New Patient Prompt', 'Used for new or referral patient consultations', department.newPatientPromptId)}
                  {renderPromptCard(
                    'Revisit / Follow-up Prompt',
                    'Used for returning patient or follow-up consultations',
                    department.revisitPromptId,
                  )}
                  {renderPromptCard('Pre-Summary Prompt', 'Used for generating pre-summary before the final summary', department.preSummaryPromptId)}
                </div>
              </div>

              {department.promptConfig && Object.keys(department.promptConfig).length > 0 && (
                <>
                  <Separator />
                  <div>
                    <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                      <Settings className="size-4" />
                      Advanced Configuration
                    </h4>
                    {renderPromptConfigKV(department.promptConfig)}
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12">
            <Building2 className="text-muted-foreground/50 mb-3 size-10" />
            <p className="text-muted-foreground text-sm">Department not found.</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Departments Tab
// ---------------------------------------------------------------------------

const DEPT_STATUS_OPTIONS = [
  { value: '_all', label: 'All Statuses' },
  { value: 'ENABLED', label: 'Enabled' },
  { value: 'DISABLED', label: 'Disabled' },
];

function DepartmentsTab({ tenantId, refreshSignal }: { tenantId: string; refreshSignal: number }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('_all');

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [promptConfigOpen, setPromptConfigOpen] = useState(false);
  const [selectedDept, setSelectedDept] = useState<Department | null>(null);

  const { data: departments = [], isLoading, refetch: refetchDepartments } = useTenantDepartments(tenantId);
  const { data: promptsData, refetch: refetchPrompts } = usePromptTemplates(tenantId, { page: 1, limit: 200 });
  const prompts = promptsData?.data ?? [];
  const lastHandledRefreshSignalRef = useRef<number>(refreshSignal);

  useEffect(() => {
    if (refreshSignal === lastHandledRefreshSignalRef.current) {
      return;
    }

    lastHandledRefreshSignalRef.current = refreshSignal;
    void Promise.all([Promise.resolve(refetchDepartments()), Promise.resolve(refetchPrompts())])
      .then(([departmentsResult, promptsResult]) => {
        if (departmentsResult?.error || promptsResult?.error) {
          toast.error('Failed to refresh tenant departments');
        }
      })
      .catch(() => {
        toast.error('Failed to refresh tenant departments');
      });
  }, [refreshSignal, refetchDepartments, refetchPrompts]);

  const filteredDepartments = useMemo(() => {
    let result = departments;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (d) =>
          (d.name && d.name.toLowerCase().includes(q)) ||
          (d.code && d.code.toLowerCase().includes(q)) ||
          (d.description && d.description.toLowerCase().includes(q)),
      );
    }
    if (statusFilter !== '_all') {
      result = result.filter((d) => (d.resourceStatus ?? 'ENABLED').toUpperCase() === statusFilter);
    }
    return result;
  }, [departments, search, statusFilter]);

  const createMutation = useCreateTenantDepartment(tenantId);
  const updateMutation = useUpdateTenantDepartment(tenantId);
  const promptConfigMutation = useUpdateTenantDepartmentPromptConfig(tenantId);
  const deleteMutation = useDeleteTenantDepartment(tenantId);

  const handleCreate = useCallback(
    (values: DeptCreateFormValues | DeptEditFormValues) => {
      createMutation.mutate(
        {
          code: values.code || undefined,
          name: values.name,
          description: values.description || undefined,
          parentDepartmentId: values.parentDepartmentId || undefined,
        },
        {
          onSuccess: (dept) => {
            toast.success(`Department "${dept.name}" created`);
            setCreateOpen(false);
          },
          onError: (err) => toast.error(`Failed to create department: ${err.message}`),
        },
      );
    },
    [createMutation],
  );

  const handleEdit = useCallback(
    (values: DeptCreateFormValues | DeptEditFormValues) => {
      if (!selectedDept) return;
      const editValues = values as DeptEditFormValues;
      const expectedVersion = typeof selectedDept.version === 'number' ? selectedDept.version : 1;
      updateMutation.mutate(
        {
          id: selectedDept.id,
          code: editValues.code || undefined,
          name: editValues.name,
          description: editValues.description || undefined,
          parentDepartmentId: editValues.parentDepartmentId || null,
          defaultSummaryTemplate: editValues.defaultSummaryTemplate || undefined,
          expectedVersion,
          ifMatch: `"${expectedVersion}"`,
        },
        {
          onSuccess: (dept) => {
            toast.success(`Department "${dept.name}" updated`);
            setEditOpen(false);
            setSelectedDept(null);
          },
          onError: (err) => toast.error(`Failed to update department: ${err.message}`),
        },
      );
    },
    [selectedDept, updateMutation],
  );

  const handlePromptConfig = useCallback(
    (values: DeptPromptConfigValues) => {
      if (!selectedDept) return;
      const expectedVersion = typeof selectedDept.version === 'number' ? selectedDept.version : 1;
      promptConfigMutation.mutate(
        {
          id: selectedDept.id,
          preSummaryPromptId: values.preSummaryPromptId || undefined,
          newPatientPromptId: values.newPatientPromptId || undefined,
          revisitPromptId: values.revisitPromptId || undefined,
          expectedVersion,
          ifMatch: `"${expectedVersion}"`,
        },
        {
          onSuccess: () => {
            toast.success('Prompt configuration updated');
            setPromptConfigOpen(false);
            setSelectedDept(null);
          },
          onError: (err) => toast.error(`Failed to update prompt config: ${err.message}`),
        },
      );
    },
    [selectedDept, promptConfigMutation],
  );

  const handleDelete = useCallback(() => {
    if (!selectedDept) return;
    deleteMutation.mutate(selectedDept.id, {
      onSuccess: () => {
        toast.success(`Department "${selectedDept.name || selectedDept.code}" deleted`);
        setDeleteOpen(false);
        setSelectedDept(null);
      },
      onError: (err) => toast.error(`Failed to delete department: ${err.message}`),
    });
  }, [selectedDept, deleteMutation]);

  const handleToggleStatus = useCallback(
    (dept: Department) => {
      const current = (dept.resourceStatus ?? 'ENABLED').toUpperCase();
      const next = current === 'ENABLED' ? 'DISABLED' : 'ENABLED';
      const expectedVersion = typeof dept.version === 'number' ? dept.version : 1;
      updateMutation.mutate(
        { id: dept.id, resourceStatus: next, expectedVersion, ifMatch: `"${expectedVersion}"` },
        {
          onSuccess: () => toast.success(`Department ${next === 'ENABLED' ? 'enabled' : 'disabled'}`),
          onError: (err) => toast.error(`Status update failed: ${err.message}`),
        },
      );
    },
    [updateMutation],
  );

  const promptNameMap = useMemo(() => {
    const map = new Map<string, string>();
    prompts.forEach((p) => map.set(p.id, p.name));
    return map;
  }, [prompts]);

  const columns = useMemo<ColumnDef<Department, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Department',
        cell: ({ row }) => {
          const d = row.original;
          return (
            <div className="flex items-center gap-3">
              <div className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-md">
                <Building2 className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="font-medium">{d.name || 'Unnamed'}</p>
                <div className="mt-0.5 flex items-center gap-1.5">
                  {d.code && <span className="text-muted-foreground font-mono text-xs">{d.code}</span>}
                  {!d.isRootDepartment && (
                    <span className="text-muted-foreground flex items-center text-xs">
                      <ChevronRight className="size-3" />
                      child
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        },
      },
      {
        id: 'status',
        header: 'Status',
        size: 100,
        cell: ({ row }) => <StatusBadge status={String(row.original.resourceStatus ?? 'ENABLED')} />,
      },
      {
        id: 'prompts',
        header: 'Prompt Config',
        cell: ({ row }) => {
          const d = row.original;
          const assignments = [
            {
              label: 'New Patient',
              id: d.newPatientPromptId,
            },
            {
              label: 'Revisit',
              id: d.revisitPromptId,
            },
            {
              label: 'Pre-Summary',
              id: d.preSummaryPromptId,
            },
          ];
          const configuredCount = assignments.filter((a) => a.id).length;
          const tooltipLines = assignments.map((a) => {
            const name = a.id ? promptNameMap.get(a.id) || 'Unknown' : 'Not assigned';
            return `${a.label}: ${name}`;
          });
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn(
                      'cursor-default text-xs',
                      configuredCount === 3
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                        : configuredCount > 0
                          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                          : 'bg-red-500/15 text-red-700 dark:text-red-400',
                    )}
                  >
                    {configuredCount}/3 assigned
                  </Badge>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                <div className="space-y-1 text-xs">
                  {tooltipLines.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: 'template',
        header: 'Template',
        size: 120,
        cell: ({ row }) => <span className="text-muted-foreground text-sm">{row.original.defaultSummaryTemplate || '—'}</span>,
      },
      {
        id: 'actions',
        header: '',
        size: 48,
        cell: ({ row }) => {
          const d = row.original;
          const isEnabled = (d.resourceStatus ?? 'ENABLED').toUpperCase() === 'ENABLED';

          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    setSelectedDept(d);
                    setDetailOpen(true);
                  }}
                >
                  <Eye className="mr-2 size-4" />
                  View Details
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setSelectedDept(d);
                    setEditOpen(true);
                  }}
                >
                  <Pencil className="mr-2 size-4" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setSelectedDept(d);
                    setPromptConfigOpen(true);
                  }}
                >
                  <Settings2 className="mr-2 size-4" />
                  Prompt Config
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleToggleStatus(d)}>
                  {isEnabled ? <PowerOff className="mr-2 size-4" /> : <Power className="mr-2 size-4" />}
                  {isEnabled ? 'Disable' : 'Enable'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => {
                    setSelectedDept(d);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 className="mr-2 size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [handleToggleStatus, promptNameMap],
  );

  return (
    <>
      <AdminDataTable
        data={filteredDepartments}
        columns={columns}
        isLoading={isLoading}
        emptyMessage="No departments in this tenant."
        onRowClick={(d) => {
          setSelectedDept(d);
          setDetailOpen(true);
        }}
        toolbar={
          <SearchFilterBar
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search by name, code, or description…"
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            statusOptions={DEPT_STATUS_OPTIONS}
          >
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1 size-4" />
              Add Department
            </Button>
          </SearchFilterBar>
        }
      />

      <TenantDeptFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        departments={departments}
        isPending={createMutation.isPending}
        onSubmit={handleCreate}
      />

      <TenantDeptFormDialog
        open={editOpen}
        onOpenChange={(v) => {
          setEditOpen(v);
          if (!v) setSelectedDept(null);
        }}
        department={selectedDept}
        departments={departments}
        isPending={updateMutation.isPending}
        onSubmit={handleEdit}
      />

      <TenantDeptPromptConfigDialog
        open={promptConfigOpen}
        onOpenChange={(v) => {
          setPromptConfigOpen(v);
          if (!v) setSelectedDept(null);
        }}
        department={selectedDept}
        prompts={prompts}
        isPending={promptConfigMutation.isPending}
        onSubmit={handlePromptConfig}
      />

      <TenantDeptDetailDialog
        open={detailOpen}
        onOpenChange={(v) => {
          setDetailOpen(v);
          if (!v) setSelectedDept(null);
        }}
        department={selectedDept}
        prompts={prompts}
        departments={departments}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(v: boolean) => {
          setDeleteOpen(v);
          if (!v) setSelectedDept(null);
        }}
        title="Delete Department"
        description={`Are you sure you want to delete "${selectedDept?.name || selectedDept?.code || 'this department'}"? Departments with child departments cannot be deleted.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Tenant Detail View — Card i (info + tabs selector) + Card ii (tab content)
// ---------------------------------------------------------------------------

function TenantDetailView({ tenantId, onDeleted, refreshSignal }: { tenantId: string; onDeleted: () => void; refreshSignal: number }) {
  const [activeTab, setActiveTab] = useState<string>('users');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const lastHandledRefreshSignalRef = useRef<number>(refreshSignal);

  // TASK-328 A2/A4 — "Manage as tenant": global-scope admins can pivot into the
  // tenant-scoped admin views. Reuses the Wave-2 scope mechanism (`setTenant`),
  // whose change is observed by `ScopeSyncInit` to invalidate the query cache;
  // we also invalidate explicitly so the pivot is self-contained.
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isGlobalScope = useAuthStore((s) => s.isGlobalScope());
  const setTenant = useAuthStore((s) => s.setTenant);

  const { data: tenant, isLoading, refetch: refetchTenant } = useTenant(tenantId);
  const { data: usage, isLoading: usageLoading, refetch: refetchTenantUsage } = useTenantUsage(tenantId);
  const { data: tenantUsersData, refetch: refetchTenantUsers } = useAdminUsersByTenant(tenantId, {
    page: 1,
    limit: 50,
  });
  const deleteTenant = useDeleteTenant();
  const toggleStatus = useToggleTenantStatus();

  const tenantAdmins = useMemo(() => {
    if (!tenantUsersData?.data) return [];
    return tenantUsersData.data.filter((u) => {
      const assignments = u.UserRoleAssignments;
      if (Array.isArray(assignments)) {
        return assignments.some(
          (a) => typeof a.roleName === 'string' && (a.roleName.toUpperCase().includes('ADMIN') || a.roleName.toUpperCase().includes('OWNER')),
        );
      }
      const username = u.username.toLowerCase();
      return username.includes('admin') || username.includes('owner');
    });
  }, [tenantUsersData]);

  const handleDelete = () => {
    deleteTenant.mutate(tenantId, {
      onSuccess: () => {
        toast.success('Tenant deleted');
        setShowDeleteConfirm(false);
        onDeleted();
      },
      onError: (err) => toast.error(err.message),
    });
  };

  const handleToggleStatus = () => {
    if (!tenant) return;
    const current = (tenant.resourceStatus || 'ENABLED').toUpperCase();
    const next = current === 'ENABLED' ? 'DISABLED' : 'ENABLED';
    toggleStatus.mutate(
      { id: tenantId, resourceStatus: next },
      {
        onSuccess: () => toast.success(`Tenant ${next === 'ENABLED' ? 'enabled' : 'disabled'}`),
        onError: (err) => toast.error(err.message),
      },
    );
  };

  const handleManageAsTenant = () => {
    if (!tenant) return;
    setTenant(tenant.id, tenant.name);
    void queryClient.invalidateQueries();
    toast.success(`Now managing as ${tenant.name}`);
    void navigate({ to: '/admin/configurations' });
  };

  useEffect(() => {
    if (refreshSignal === lastHandledRefreshSignalRef.current) {
      return;
    }

    lastHandledRefreshSignalRef.current = refreshSignal;
    void Promise.all([Promise.resolve(refetchTenant()), Promise.resolve(refetchTenantUsage()), Promise.resolve(refetchTenantUsers())])
      .then(([tenantResult, usageResult, usersResult]) => {
        if (tenantResult?.error || usageResult?.error || usersResult?.error) {
          toast.error('Failed to refresh tenant detail data');
        }
      })
      .catch(() => {
        toast.error('Failed to refresh tenant detail data');
      });
  }, [refreshSignal, refetchTenant, refetchTenantUsage, refetchTenantUsers]);

  if (isLoading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (!tenant) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-16">
        <Building2 className="size-10 opacity-40" />
        <p className="text-sm">Tenant not found</p>
      </div>
    );
  }

  const isEnabled = (tenant.resourceStatus || 'ENABLED').toUpperCase() === 'ENABLED';

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-start gap-3">
        <div className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg">
          <Building2 className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-lg font-semibold">{tenant.name}</h3>
            <StatusBadge status={tenant.resourceStatus || 'ENABLED'} />
          </div>
          <p className="text-muted-foreground mt-0.5 font-mono text-xs">{tenant.key}</p>
          {Boolean((tenant as Record<string, unknown>).description) && (
            <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{String((tenant as Record<string, unknown>).description)}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isGlobalScope && (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleManageAsTenant}>
              <LogIn className="mr-1 size-3" />
              Manage as tenant
            </Button>
          )}
          <Switch checked={isEnabled} onCheckedChange={handleToggleStatus} disabled={toggleStatus.isPending} size="sm" />
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive h-7 text-xs"
            onClick={() => setShowDeleteConfirm(true)}
          >
            <Trash2 className="mr-1 size-3" />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-muted-foreground text-xs">Created</p>
          <p className="flex items-center gap-1">
            <Calendar className="size-3" />
            {formatDate(tenant.createdAt)}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground text-xs">Updated</p>
          <p className="flex items-center gap-1">
            <Calendar className="size-3" />
            {formatDate(tenant.updatedAt)}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground text-xs">Users</p>
          {usageLoading && !tenantUsersData ? (
            <Skeleton className="mt-1 h-5 w-10" />
          ) : (
            <p className="flex items-center gap-1 font-semibold">
              <Users className="size-3" />
              {tenantUsersData?.count ?? usage?.totalUsers ?? 0}
            </p>
          )}
        </div>
        <div>
          <p className="text-muted-foreground text-xs">Departments</p>
          {usageLoading ? (
            <Skeleton className="mt-1 h-5 w-10" />
          ) : (
            <p className="flex items-center gap-1 font-semibold">
              <Layers className="size-3" />
              {usage?.totalDepartments ?? 0}
            </p>
          )}
        </div>
      </div>

      <div>
        <p className="text-muted-foreground mb-1 text-xs">Tenant Admins</p>
        {tenantAdmins.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {tenantAdmins.map((a) => (
              <Badge key={a.id} variant="secondary" className="text-xs">
                <Shield className="mr-1 size-3" />
                {a.username}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs italic">No admins identified — admin detection requires role data from the backend</p>
        )}
      </div>

      <Separator />

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="users" className="gap-1.5">
            <Users className="size-3.5" />
            User Assignments
          </TabsTrigger>
          <TabsTrigger value="departments" className="gap-1.5">
            <Building2 className="size-3.5" />
            Department Assignments
          </TabsTrigger>
          <TabsTrigger value="prompts" className="gap-1.5">
            <FileText className="size-3.5" />
            Prompts
          </TabsTrigger>
          <TabsTrigger value="storage" className="gap-1.5">
            <HardDrive className="size-3.5" />
            Storage
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="mt-4">
          <UsersTab tenantId={tenantId} refreshSignal={refreshSignal} />
        </TabsContent>
        <TabsContent value="departments" className="mt-4">
          <DepartmentsTab tenantId={tenantId} refreshSignal={refreshSignal} />
        </TabsContent>
        {/* TASK-328 A2 — reuse the Prompts/Storage admin pages, locked to this
            tenant via `scopedTenantId` + `embedded` (composition, not a fork). */}
        <TabsContent value="prompts" className="mt-4">
          <PromptManagementPage scopedTenantId={tenantId} embedded />
        </TabsContent>
        <TabsContent value="storage" className="mt-4">
          <StorageManagementPage scopedTenantId={tenantId} embedded />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Tenant"
        description={`Are you sure you want to delete "${tenant.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={deleteTenant.isPending}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function TenantManagementPage() {
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [searchQuery, setSearchQuery] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [statusFilter, setStatusFilter] = useState('_all');
  const [detailRefreshSignal, setDetailRefreshSignal] = useState(0);

  const { data: tenantsPages, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage, refetch: refetchTenants } = useTenantsInfinite();

  const allTenants = useMemo(() => tenantsPages?.pages.flatMap((p) => p.data) ?? [], [tenantsPages]);

  const filteredTenants = useMemo(
    () =>
      allTenants.filter((t) => {
        const matchesSearch = t.name.toLowerCase().includes(searchQuery.toLowerCase()) || t.key.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesStatus = statusFilter === '_all' || (t.resourceStatus ?? 'ENABLED').toUpperCase() === statusFilter;
        return matchesSearch && matchesStatus;
      }),
    [allTenants, searchQuery, statusFilter],
  );

  const tenantsColumn: MultiColumnConfig<Tenant> = {
    id: 'tenants',
    title: 'Tenants',
    showItemCount: true,
    width: '180px',
    skeletonCount: 5,
    skeletonHeight: 'h-14',
    estimateItemSize: 72,
    headerActions: (
      <Button
        size="sm"
        className="h-7 gap-1 text-xs"
        onClick={() => {
          setIsCreating(true);
          setSelectedTenantId(null);
        }}
      >
        <Plus className="size-3.5" />
        New
      </Button>
    ),
    emptyIcon: <Building2 className="size-5" />,
    emptyTitle: searchQuery || statusFilter !== '_all' ? 'No tenants match your criteria.' : 'No tenants yet.',
    onRefresh: () => {
      void Promise.resolve(refetchTenants()).then((result) => {
        if (result?.error) {
          toast.error('Failed to refresh tenants');
        }
      });
    },
    keyExtractor: (t) => t.id,
    renderItem: (t) => (
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{t.name}</p>
          <p className="text-muted-foreground truncate text-xs">{t.key}</p>
        </div>
        <StatusBadge status={t.resourceStatus ?? 'ENABLED'} />
      </div>
    ),
  };

  const tenantsState: MultiColumnState<Tenant> = {
    data: filteredTenants,
    isLoading,
    selectedId: selectedTenantId,
    onSelect: (id) => {
      setSelectedTenantId(id);
      setIsCreating(false);
    },
    hasMore: !!hasNextPage,
    onLoadMore: () => fetchNextPage(),
    isLoadingMore: isFetchingNextPage,
  };

  const detailColumn: MultiColumnContentConfig = {
    type: 'content',
    id: 'detail',
    title: 'Tenant Detail',
    subtitle: selectedTenantId ? filteredTenants.find((t) => t.id === selectedTenantId)?.name : isCreating ? 'Create New Tenant' : 'Select a tenant',
    width: '1fr',
    emptyIcon: <Building2 className="size-5" />,
    emptyTitle: 'No tenant selected',
    emptyDescription: 'Choose a tenant from the list or create a new one.',
    onRefresh: () => {
      if (!selectedTenantId || isCreating) {
        return;
      }

      setDetailRefreshSignal((previous) => previous + 1);
    },
    renderContent: () => {
      if (isCreating) {
        return (
          <div className="p-4">
            <CreateTenantForm
              onSuccess={(tenant) => {
                setIsCreating(false);
                setSelectedTenantId(tenant.id);
              }}
              onCancel={() => setIsCreating(false)}
            />
          </div>
        );
      }
      if (selectedTenantId) {
        return (
          <TenantDetailView
            key={selectedTenantId}
            tenantId={selectedTenantId}
            onDeleted={() => setSelectedTenantId(null)}
            refreshSignal={detailRefreshSignal}
          />
        );
      }
      return null;
    },
  };

  const detailState: MultiColumnState<never> = {
    data: [],
    isLoading: false,
    enabled: isCreating || !!selectedTenantId,
    selectedId: null,
    onSelect: () => {},
  };

  return (
    <Main>
      <div className="mb-4">
        <h2 className="text-2xl font-bold tracking-tight">Tenant Management</h2>
        <p className="text-muted-foreground mt-1">Create, configure, and manage tenants across the platform.</p>
      </div>
      <MultiColumnLayout columns={[tenantsColumn, detailColumn]} columnStates={[tenantsState, detailState]} height="calc(100vh - 12rem)" />
    </Main>
  );
}

export { AuditLogsTab, ConfigsTab };
