import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ColumnDef,
  PaginationState,
  RowSelectionState,
} from '@tanstack/react-table'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@/lib/zod-resolver'
import { toast } from 'sonner'

import { Button } from '@arcaai/ui/button'
import { Badge } from '@arcaai/ui/badge'
import { Skeleton } from '@arcaai/ui/skeleton'
import { Checkbox } from '@arcaai/ui/checkbox'
import { Input } from '@arcaai/ui/input'
import { ScrollArea } from '@arcaai/ui/scroll-area'
import { Separator } from '@arcaai/ui/separator'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@arcaai/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@arcaai/ui/select'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@arcaai/ui/form'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@arcaai/ui/dropdown-menu'
import {
  Calendar,
  Clock,
  Copy,
  Eye,
  Globe,
  Key,
  KeyRound,
  Loader2,
  Mail,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  Power,
  PowerOff,
  Settings,
  Shield,
  ShieldAlert,
  Trash2,
  User as UserIcon,
  Users,
} from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@arcaai/ui/tooltip'

import { DEFAULT_PAGE_SIZE } from '@arcaai/vox'

import { Main } from '@/components/layout/main'

import {
  AdminDataTable,
  ConfirmDialog,
  SearchFilterBar,
  StatusBadge,
} from '../components'
import {
  type AdminUser,
  type UserApiKey,
  type UserSetting,
  useAdminUser,
  useAdminUsers,
  useAdminUserSettings,
  useUpdateAdminUserSetting,
  useBulkDeleteUsers,
  useCreateUser,
  useDeleteUser,
  useUpdateUser,
  useUpdateUserStatus,
  useUserApiKeys,
  useRevokeApiKey,
} from '../api/users'
import { useTenants, type Tenant } from '../api/tenants'
import { useRoles, type Role } from '../api/roles'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createSchema = z.object({
  username: z.string().min(1, 'Username is required').max(64),
  password: z.string().min(6, 'Minimum 6 characters'),
  externalId: z.string(),
  isServiceAccount: z.boolean(),
})

const editSchema = z.object({
  username: z.string().min(1, 'Username is required').max(64),
  password: z.string().refine((v) => !v || v.length >= 6, 'Minimum 6 characters'),
  externalId: z.string(),
  isServiceAccount: z.boolean(),
})

type UserFormValues = z.infer<typeof createSchema>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = [
  { value: '_all', label: 'All Statuses' },
  { value: 'ENABLED', label: 'Enabled' },
  { value: 'DISABLED', label: 'Disabled' },
  { value: 'ARCHIVED', label: 'Archived' },
]

const ACCOUNT_TYPE_OPTIONS = [
  { value: '_all', label: 'All Types' },
  { value: 'user', label: 'User' },
  { value: 'service', label: 'Service Account' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(dateStr?: string | null): string {
  if (!dateStr) return '—'
  const ms = Date.now() - new Date(dateStr).getTime()
  const sec = Math.floor(ms / 1000)
  const min = Math.floor(sec / 60)
  const hr = Math.floor(min / 60)
  const day = Math.floor(hr / 24)
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (day > 30) {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }
  if (day >= 1) return rtf.format(-day, 'day')
  if (hr >= 1) return rtf.format(-hr, 'hour')
  if (min >= 1) return rtf.format(-min, 'minute')
  return rtf.format(-sec, 'second')
}

function fmtDate(dateStr?: string | null): string {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getUserDisplayName(user: AdminUser): string {
  const profile = user.UserProfile
  if (profile?.firstName || profile?.lastName) {
    return [profile.firstName, profile.lastName].filter(Boolean).join(' ')
  }
  return user.username
}

// ---------------------------------------------------------------------------
// InfoRow (detail dialog helper)
// ---------------------------------------------------------------------------

function InfoRow({
  label,
  value,
  icon,
  children,
}: {
  label: string
  value?: string
  icon?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5">
      {icon && (
        <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
      )}
      <div className="min-w-0">
        <p className="text-muted-foreground text-xs leading-none">{label}</p>
        <div className="mt-1">
          {children ?? (
            <p className="text-sm font-medium leading-none">{value ?? '—'}</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// UserFormDialog — shared by Create and Edit
// ---------------------------------------------------------------------------

function UserFormDialog({
  open,
  onOpenChange,
  user,
  isPending,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  user?: AdminUser | null
  isPending: boolean
  onSubmit: (values: UserFormValues) => void
}) {
  const isEdit = !!user

  const form = useForm<UserFormValues>({
    resolver: zodResolver(isEdit ? editSchema : createSchema),
    defaultValues: {
      username: '',
      password: '',
      externalId: '',
      isServiceAccount: false,
    },
  })

  useEffect(() => {
    if (open) {
      form.reset({
        username: user?.username ?? '',
        password: '',
        externalId: user?.externalId ?? '',
        isServiceAccount: user?.isServiceAccount ?? false,
      })
    }
  }, [open, user, form])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit User' : 'Create User'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update the user details below.'
              : 'Fill in the details to create a new user account.'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="username"
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
              name="password"
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>
                    Password
                    {isEdit && (
                      <span className="text-muted-foreground ml-1 text-xs font-normal">
                        (leave blank to keep current)
                      </span>
                    )}
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder={isEdit ? '••••••••' : 'Enter password'}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="externalId"
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>
                    External ID
                    <span className="text-muted-foreground ml-1 text-xs font-normal">
                      (optional)
                    </span>
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
              render={({ field }: { field: any }) => (
                <FormItem className="flex items-center gap-2 space-y-0">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <FormLabel className="text-sm font-normal">
                    This is a service account
                  </FormLabel>
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
                {isPending && (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                )}
                {isEdit ? 'Save Changes' : 'Create User'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// ApiKeyCard — individual API key display with revoke action
// ---------------------------------------------------------------------------

function ApiKeyCard({
  apiKey,
  onRevoke,
  isRevoking,
}: {
  apiKey: UserApiKey
  onRevoke: (id: string) => void
  isRevoking: boolean
}) {
  const [copied, setCopied] = useState(false)
  const scopes = apiKey.scopes ?? []
  const isRevoked = apiKey.keyStatus?.toUpperCase() === 'REVOKED'
  const canRevoke = !isRevoked && apiKey.keyStatus?.toUpperCase() !== 'EXPIRED'

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(apiKey.keyPrefix).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [apiKey.keyPrefix])

  return (
    <div className="bg-muted/30 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">
              {apiKey.keyName || '—'}
            </p>
            <StatusBadge status={apiKey.keyStatus ?? 'ACTIVE'} />
            {apiKey.keyType && (
              <Badge variant="outline" className="text-[10px]">
                {apiKey.keyType}
              </Badge>
            )}
          </div>
          {apiKey.description && (
            <p className="text-muted-foreground mt-0.5 text-xs">
              {apiKey.description}
            </p>
          )}
        </div>
        {canRevoke && (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive h-7 shrink-0 text-xs"
            onClick={() => onRevoke(apiKey.id)}
            disabled={isRevoking}
          >
            {isRevoking ? (
              <Loader2 className="mr-1 size-3 animate-spin" />
            ) : (
              <ShieldAlert className="mr-1 size-3" />
            )}
            Revoke
          </Button>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <code
          className={`bg-background flex-1 truncate rounded border px-2.5 py-1.5 font-mono text-xs ${isRevoked ? 'line-through opacity-50' : ''}`}
        >
          {apiKey.keyPrefix}
        </code>
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={handleCopy}
              >
                <Copy className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {copied ? 'Copied!' : 'Copy prefix'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {apiKey.expiresAt && (
          <span className="flex items-center gap-1">
            <Calendar className="size-3" />
            Expires {fmtDate(apiKey.expiresAt)}
          </span>
        )}
        {apiKey.lastUsedAt && (
          <span className="flex items-center gap-1">
            <Clock className="size-3" />
            Last used {relativeTime(apiKey.lastUsedAt)}
          </span>
        )}
        {apiKey.environment && (
          <span className="flex items-center gap-1">
            <Globe className="size-3" />
            {apiKey.environment}
          </span>
        )}
        {typeof apiKey.usageCount === 'number' && (
          <span>{apiKey.usageCount.toLocaleString()} requests</span>
        )}
      </div>

      {scopes.length > 0 && (
        <div className="mt-3 border-t pt-3">
          <p className="text-muted-foreground mb-1.5 flex items-center gap-1 text-xs font-medium">
            <Shield className="size-3" />
            Scopes ({scopes.length})
          </p>
          <div className="flex flex-wrap gap-1">
            {scopes.map((scope) => (
              <Badge
                key={scope}
                variant="secondary"
                className="px-1.5 py-0 font-mono text-[10px] leading-5"
              >
                {scope}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RoleAssignmentSection — shows roles and allows assignment
// ---------------------------------------------------------------------------

function RoleAssignmentSection({ user }: { user: AdminUser }) {
  const { data: rolesData, isLoading: rolesLoading } = useRoles({ page: 1, limit: 100 })
  const { data: tenantsData } = useTenants({ page: 1, limit: 100 })
  const [showAssign, setShowAssign] = useState(false)
  const [selectedRoleId, setSelectedRoleId] = useState('')
  const [selectedTenantId, setSelectedTenantId] = useState('')

  const roles = rolesData?.data ?? []
  const tenants = tenantsData?.data ?? []
  const assignments = user.UserRoleAssignments ?? []

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <Shield className="size-4" />
          Roles
          {assignments.length > 0 && (
            <Badge variant="secondary" className="ml-1 text-xs">
              {assignments.length}
            </Badge>
          )}
        </h4>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setShowAssign(!showAssign)}
        >
          <Plus className="mr-1 size-3" />
          Assign Role
        </Button>
      </div>

      {showAssign && (
        <div className="bg-muted/30 mb-3 space-y-3 rounded-lg border p-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-muted-foreground mb-1 block text-xs">Role</label>
              {rolesLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select value={selectedRoleId} onValueChange={setSelectedRoleId}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select a role…" />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                        {r.description && (
                          <span className="text-muted-foreground ml-1 text-xs">
                            — {r.description}
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div>
              <label className="text-muted-foreground mb-1 block text-xs">Tenant (scope)</label>
              <Select value={selectedTenantId} onValueChange={setSelectedTenantId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Global (default)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__global__">Global (default)</SelectItem>
                  {tenants.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} ({t.key})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            Role assignment requires the backend UserRoleAssignment endpoints to be exposed via the admin API. Currently, role data is read-only from the user response.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowAssign(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!selectedRoleId}
              onClick={() => {
                toast.info('Role assignment requires a dedicated backend endpoint (POST /admin/users/:id/roles). This UI is ready for integration.')
                setShowAssign(false)
              }}
            >
              Assign
            </Button>
          </div>
        </div>
      )}

      {assignments.length > 0 ? (
        <div className="space-y-2">
          {assignments.map((a) => (
            <div
              key={a.id}
              className="bg-muted/20 flex items-center justify-between rounded-md border px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <Shield className="text-muted-foreground size-3.5" />
                <span className="text-sm font-medium">{a.roleName || a.roleId}</span>
                {a.tenantId && (
                  <Badge variant="outline" className="text-[10px]">
                    {a.tenantId.slice(0, 8)}…
                  </Badge>
                )}
              </div>
              <StatusBadge status={a.resourceStatus || 'ENABLED'} />
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-muted/20 flex flex-col items-center justify-center rounded-lg border border-dashed py-6">
          <Shield className="text-muted-foreground/50 mb-2 size-6" />
          <p className="text-muted-foreground text-xs">
            No role assignments found. Role data requires the backend to include UserRoleAssignments in the user response.
          </p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TASK-245: UserPreferencesSection — SDK settings management for a user
// ---------------------------------------------------------------------------

const SDK_NAMESPACE = 'arcaai-sdk'

function parseSettingValue(setting: UserSetting): unknown {
  const dt = String(setting.dataType ?? 'STRING').toUpperCase()
  if (dt === 'BOOLEAN') return setting.value === 'true'
  if (dt === 'NUMBER' || dt === 'FLOAT' || dt === 'INTEGER')
    return Number(setting.value)
  if (dt === 'JSON') {
    try { return JSON.parse(setting.value) }
    catch { return setting.value }
  }
  return setting.value
}

function SettingValueEditor({
  setting,
  value,
  onChange,
}: {
  setting: UserSetting
  value: string
  onChange: (v: string) => void
}) {
  const dt = String(setting.dataType ?? 'STRING').toUpperCase()
  if (dt === 'BOOLEAN') {
    return (
      <select
        className="bg-background h-9 rounded-md border px-2 text-sm"
        aria-label={`Value for ${setting.name || setting.key}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }
  if (dt === 'JSON' || value.length > 120 || value.includes('\n')) {
    return (
      <textarea
        className="bg-background min-h-28 w-full rounded-md border p-2 font-mono text-sm"
        aria-label={`Value for ${setting.name || setting.key}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return (
    <Input
      value={value}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      aria-label={`Value for ${setting.name || setting.key}`}
    />
  )
}

function UserPreferencesSection({ userId }: { userId: string }) {
  const { data: allSettings, isLoading } = useAdminUserSettings(userId)
  const updateMut = useUpdateAdminUserSetting()
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [draftValue, setDraftValue] = useState('')

  const sdkSettings = useMemo(
    () => (allSettings ?? []).filter((s) => s.namespace === SDK_NAMESPACE),
    [allSettings],
  )

  const startEdit = useCallback((setting: UserSetting) => {
    setEditingKey(setting.key)
    setDraftValue(String(setting.value ?? ''))
  }, [])

  const cancelEdit = useCallback(() => {
    setEditingKey(null)
    setDraftValue('')
  }, [])

  const handleSave = useCallback(
    (setting: UserSetting) => {
      updateMut.mutate(
        {
          userId,
          namespace: SDK_NAMESPACE,
          key: setting.key,
          value: draftValue,
          dataType: setting.dataType,
          name: setting.name,
        },
        {
          onSuccess: () => {
            toast.success(`Updated ${setting.name || setting.key}`)
            setEditingKey(null)
          },
          onError: (err) => toast.error(err.message),
        },
      )
    },
    [userId, draftValue, updateMut],
  )

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <Settings className="size-4" />
          SDK Preferences
          {sdkSettings.length > 0 && (
            <Badge variant="secondary" className="ml-1 text-xs">
              {sdkSettings.length}
            </Badge>
          )}
        </h4>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : sdkSettings.length > 0 ? (
        <div className="flex flex-col gap-2">
          {sdkSettings.map((setting) => {
            const isEditing = editingKey === setting.key
            const isDirty = isEditing && draftValue !== String(setting.value ?? '')
            return (
              <div
                key={setting.id}
                className="bg-muted/20 rounded-lg border p-3"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {setting.name || setting.key}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {String(setting.dataType ?? 'STRING')}
                    </Badge>
                  </div>
                  {isEditing ? (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={cancelEdit}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        disabled={!isDirty || updateMut.isPending}
                        onClick={() => handleSave(setting)}
                      >
                        Save
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => startEdit(setting)}
                    >
                      Edit
                    </Button>
                  )}
                </div>
                <p className="text-muted-foreground mb-1 font-mono text-[10px]">
                  {setting.key}
                </p>
                {isEditing ? (
                  <SettingValueEditor
                    setting={setting}
                    value={draftValue}
                    onChange={setDraftValue}
                  />
                ) : (
                  <p className="truncate font-mono text-xs">
                    {String(setting.value ?? '')}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="bg-muted/20 flex flex-col items-center justify-center rounded-lg border border-dashed py-8">
          <Settings className="text-muted-foreground/50 mb-2 size-8" />
          <p className="text-muted-foreground text-sm">
            No SDK preferences found for this user.
          </p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// UserDetailDialog — shows user info, profile, roles, API keys
// ---------------------------------------------------------------------------

function UserDetailDialog({
  open,
  onOpenChange,
  userId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: string | null
}) {
  const { data: user, isLoading: userLoading } = useAdminUser(
    userId ?? '',
    { enabled: !!userId && open },
  )
  const { data: apiKeysData, isLoading: keysLoading } = useUserApiKeys(
    userId ?? '',
    undefined,
    { enabled: !!userId && open },
  )
  const revokeMut = useRevokeApiKey()
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null)

  const apiKeys = apiKeysData?.data ?? []
  const profile = user?.UserProfile

  const handleRevoke = useCallback(() => {
    if (!revokeConfirmId) return
    revokeMut.mutate(revokeConfirmId, {
      onSuccess: () => {
        toast.success('API key revoked')
        setRevokeConfirmId(null)
      },
      onError: (err) => toast.error(err.message),
    })
  }, [revokeConfirmId, revokeMut])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>User Details</DialogTitle>
          <DialogDescription>
            Account information, profile, roles, and API keys.
          </DialogDescription>
        </DialogHeader>

        {userLoading ? (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-4">
              <Skeleton className="size-12 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-20" />
              </div>
            </div>
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-32 w-full rounded-lg" />
          </div>
        ) : user ? (
          <ScrollArea className="max-h-[70vh]">
            <div className="space-y-5 pr-4">
              {/* Profile header */}
              <div className="flex items-center gap-4">
                <div className="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-full">
                  <UserIcon className="size-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-lg font-semibold">
                      {getUserDisplayName(user)}
                    </h3>
                    <StatusBadge
                      status={String(user.resourceStatus ?? 'ENABLED')}
                    />
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className="text-muted-foreground text-sm">@{user.username}</span>
                    <Badge
                      variant={
                        user.isServiceAccount ? 'secondary' : 'outline'
                      }
                      className="text-xs"
                    >
                      {user.isServiceAccount ? 'Service Account' : 'User'}
                    </Badge>
                    {user.externalId && (
                      <span className="text-muted-foreground truncate text-xs">
                        {user.externalId}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* User profile info */}
              {profile && (profile.firstName || profile.lastName || profile.email || profile.phone) && (
                <div className="bg-muted/30 grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-4">
                  {(profile.firstName || profile.lastName) && (
                    <InfoRow
                      label="Full Name"
                      icon={<UserIcon className="size-3.5" />}
                      value={[profile.firstName, profile.lastName].filter(Boolean).join(' ')}
                    />
                  )}
                  {profile.email && (
                    <InfoRow
                      label="Email"
                      icon={<Mail className="size-3.5" />}
                      value={profile.email}
                    />
                  )}
                  {profile.phone && (
                    <InfoRow
                      label="Phone"
                      icon={<Phone className="size-3.5" />}
                      value={profile.phone}
                    />
                  )}
                </div>
              )}

              {/* Activity & timestamps */}
              <div className="bg-muted/30 grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-4">
                <InfoRow
                  label="Last Login"
                  icon={<Clock className="size-3.5" />}
                  value={relativeTime(user.lastLoginAt)}
                />
                <InfoRow
                  label="Last Active"
                  icon={<Clock className="size-3.5" />}
                  value={relativeTime(user.lastActiveAt)}
                />
                <InfoRow
                  label="Created"
                  icon={<Calendar className="size-3.5" />}
                  value={fmtDate(user.createdAt)}
                />
                <InfoRow
                  label="Updated"
                  icon={<Calendar className="size-3.5" />}
                  value={fmtDate(user.updatedAt)}
                />
              </div>

              <Separator />

              {/* Roles section */}
              <RoleAssignmentSection user={user} />

              <Separator />

              {/* API Keys section */}
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <h4 className="flex items-center gap-2 text-sm font-medium">
                    <Key className="size-4" />
                    API Keys
                    {apiKeys.length > 0 && (
                      <Badge variant="secondary" className="ml-1 text-xs">
                        {apiKeys.length}
                      </Badge>
                    )}
                  </h4>
                </div>

                {keysLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-28 w-full rounded-lg" />
                    <Skeleton className="h-28 w-full rounded-lg" />
                  </div>
                ) : apiKeys.length > 0 ? (
                  <div className="space-y-3">
                    {apiKeys.map((k) => (
                      <ApiKeyCard
                        key={k.id}
                        apiKey={k}
                        onRevoke={setRevokeConfirmId}
                        isRevoking={revokeMut.isPending}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="bg-muted/20 flex flex-col items-center justify-center rounded-lg border border-dashed py-8">
                    <Key className="text-muted-foreground/50 mb-2 size-8" />
                    <p className="text-muted-foreground text-sm">
                      No API keys found for this user.
                    </p>
                  </div>
                )}
              </div>

              <Separator />

              {/* TASK-245: SDK Preferences */}
              <UserPreferencesSection userId={user.id} />
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center py-8">
            <UserIcon className="text-muted-foreground/50 mb-2 size-8" />
            <p className="text-muted-foreground text-sm">User not found.</p>
          </div>
        )}
      </DialogContent>

      <ConfirmDialog
        open={!!revokeConfirmId}
        onOpenChange={(v) => {
          if (!v) setRevokeConfirmId(null)
        }}
        title="Revoke API Key"
        description="Are you sure you want to revoke this API key? This action cannot be undone. The key will immediately stop working."
        confirmLabel="Revoke"
        variant="destructive"
        onConfirm={handleRevoke}
        isLoading={revokeMut.isPending}
      />
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function UserManagementPage() {
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  })
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('_all')
  const [accountTypeFilter, setAccountTypeFilter] = useState('_all')

  const [createOpen, setCreateOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null)

  // ---- Data ---------------------------------------------------------------

  const { data: usersData, isLoading } = useAdminUsers({
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  })

  const users = usersData?.data ?? []
  const total = usersData?.count ?? 0

  const filteredUsers = useMemo(() => {
    let result = users
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(
        (u) =>
          u.username.toLowerCase().includes(q) ||
          (u.externalId && u.externalId.toLowerCase().includes(q)) ||
          (u.UserProfile?.firstName && u.UserProfile.firstName.toLowerCase().includes(q)) ||
          (u.UserProfile?.lastName && u.UserProfile.lastName.toLowerCase().includes(q)) ||
          (u.UserProfile?.email && u.UserProfile.email.toLowerCase().includes(q)),
      )
    }
    if (statusFilter !== '_all') {
      result = result.filter(
        (u) =>
          (u.resourceStatus ?? 'ENABLED').toUpperCase() === statusFilter,
      )
    }
    if (accountTypeFilter !== '_all') {
      result = result.filter((u) =>
        accountTypeFilter === 'service'
          ? u.isServiceAccount
          : !u.isServiceAccount,
      )
    }
    return result
  }, [users, search, statusFilter, accountTypeFilter])

  // ---- Mutations ----------------------------------------------------------

  const createMutation = useCreateUser()
  const updateMutation = useUpdateUser()
  const statusMutation = useUpdateUserStatus()
  const deleteMutation = useDeleteUser()
  const bulkDeleteMutation = useBulkDeleteUsers()

  // ---- Handlers -----------------------------------------------------------

  const handleCreate = useCallback(
    (values: UserFormValues) => {
      createMutation.mutate(
        {
          username: values.username,
          password: values.password,
          externalId: values.externalId || undefined,
          isServiceAccount: values.isServiceAccount,
        },
        {
          onSuccess: () => {
            toast.success('User created successfully')
            setCreateOpen(false)
          },
          onError: (err) =>
            toast.error(`Failed to create user: ${err.message}`),
        },
      )
    },
    [createMutation],
  )

  const handleEdit = useCallback(
    (values: UserFormValues) => {
      if (!selectedUser) return
      const payload: Record<string, unknown> = {
        id: selectedUser.id,
        username: values.username,
        externalId: values.externalId || null,
        isServiceAccount: values.isServiceAccount,
      }
      if (values.password) payload.password = values.password

      updateMutation.mutate(
        payload as Parameters<typeof updateMutation.mutate>[0],
        {
          onSuccess: () => {
            toast.success('User updated successfully')
            setEditOpen(false)
            setSelectedUser(null)
          },
          onError: (err) =>
            toast.error(`Failed to update user: ${err.message}`),
        },
      )
    },
    [selectedUser, updateMutation],
  )

  const handleDelete = useCallback(() => {
    if (!selectedUser) return
    deleteMutation.mutate(selectedUser.id, {
      onSuccess: () => {
        toast.success(`User "${selectedUser.username}" deleted`)
        setDeleteOpen(false)
        setSelectedUser(null)
      },
      onError: (err) =>
        toast.error(`Failed to delete user: ${err.message}`),
    })
  }, [selectedUser, deleteMutation])

  const handleBulkDelete = useCallback(() => {
    const ids = Object.keys(rowSelection)
      .map((i) => filteredUsers[Number(i)]?.id)
      .filter(Boolean) as string[]
    if (ids.length === 0) return

    bulkDeleteMutation.mutate(ids, {
      onSuccess: () => {
        toast.success(`${ids.length} user(s) deleted`)
        setBulkDeleteOpen(false)
        setRowSelection({})
      },
      onError: (err) =>
        toast.error(`Bulk delete failed: ${err.message}`),
    })
  }, [rowSelection, filteredUsers, bulkDeleteMutation])

  const handleToggleStatus = useCallback(
    (user: AdminUser) => {
      const current = (user.resourceStatus ?? 'ENABLED').toUpperCase()
      const next = current === 'ENABLED' ? 'DISABLED' : 'ENABLED'
      statusMutation.mutate(
        { id: user.id, resourceStatus: next },
        {
          onSuccess: () =>
            toast.success(
              `User ${next === 'ENABLED' ? 'enabled' : 'disabled'}`,
            ),
          onError: (err) =>
            toast.error(`Status update failed: ${err.message}`),
        },
      )
    },
    [statusMutation],
  )

  // ---- Columns ------------------------------------------------------------

  const selectedCount = Object.keys(rowSelection).length

  const columns = useMemo<ColumnDef<AdminUser, unknown>[]>(
    () => [
      {
        accessorKey: 'username',
        header: 'User',
        cell: ({ row }) => {
          const u = row.original
          const profile = u.UserProfile
          const displayName = getUserDisplayName(u)
          return (
            <div>
              <p className="font-medium">{displayName}</p>
              {displayName !== u.username && (
                <p className="text-muted-foreground text-xs">@{u.username}</p>
              )}
              {profile?.email && (
                <p className="text-muted-foreground text-xs">{profile.email}</p>
              )}
              {!profile?.email && u.externalId && (
                <p className="text-muted-foreground text-xs">{u.externalId}</p>
              )}
            </div>
          )
        },
      },
      {
        id: 'accountType',
        header: 'Account Type',
        cell: ({ row }) => (
          <Badge
            variant={row.original.isServiceAccount ? 'secondary' : 'outline'}
          >
            {row.original.isServiceAccount ? 'Service Account' : 'User'}
          </Badge>
        ),
      },
      {
        id: 'roles',
        header: 'Roles',
        cell: ({ row }) => {
          const assignments = row.original.UserRoleAssignments ?? []
          if (assignments.length === 0) {
            return <span className="text-muted-foreground text-xs">—</span>
          }
          return (
            <div className="flex flex-wrap gap-1">
              {assignments.slice(0, 2).map((a) => (
                <Badge key={a.id} variant="secondary" className="text-[10px]">
                  {a.roleName || a.roleId.slice(0, 8)}
                </Badge>
              ))}
              {assignments.length > 2 && (
                <Badge variant="outline" className="text-[10px]">
                  +{assignments.length - 2}
                </Badge>
              )}
            </div>
          )
        },
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <StatusBadge
            status={String(row.original.resourceStatus ?? 'ENABLED')}
          />
        ),
      },
      {
        id: 'lastLogin',
        header: 'Last Login',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {relativeTime(row.original.lastLoginAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        size: 48,
        cell: ({ row }) => {
          const u = row.original
          const isEnabled =
            (u.resourceStatus ?? 'ENABLED').toUpperCase() === 'ENABLED'

          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    setSelectedUser(u)
                    setDetailOpen(true)
                  }}
                >
                  <Eye className="mr-2 size-4" />
                  View Details
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setSelectedUser(u)
                    setEditOpen(true)
                  }}
                >
                  <Pencil className="mr-2 size-4" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleToggleStatus(u)}>
                  {isEnabled ? (
                    <PowerOff className="mr-2 size-4" />
                  ) : (
                    <Power className="mr-2 size-4" />
                  )}
                  {isEnabled ? 'Disable' : 'Enable'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => {
                    setSelectedUser(u)
                    setDeleteOpen(true)
                  }}
                >
                  <Trash2 className="mr-2 size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
      },
    ],
    [handleToggleStatus],
  )

  // ---- Render -------------------------------------------------------------

  return (
    <Main>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            User Management
          </h2>
          <p className="text-muted-foreground mt-1">
            Create, edit, and manage user accounts and service accounts.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 size-4" />
          Create User
        </Button>
      </div>

      {/* Bulk actions bar */}
      {selectedCount > 0 && (
        <div className="bg-muted/60 mb-4 flex items-center justify-between rounded-lg border px-4 py-2">
          <span className="text-sm">
            {selectedCount} user{selectedCount !== 1 && 's'} selected
          </span>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="mr-2 size-4" />
            Delete Selected
          </Button>
        </div>
      )}

      {/* Data table */}
      <AdminDataTable
        data={filteredUsers}
        columns={columns}
        enableRowSelection
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={total}
        isLoading={isLoading}
        emptyMessage="No users found."
        toolbar={
          <SearchFilterBar
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search by name, username, or email…"
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            statusOptions={STATUS_OPTIONS}
          >
            <Select
              value={accountTypeFilter}
              onValueChange={setAccountTypeFilter}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCOUNT_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SearchFilterBar>
        }
      />

      {/* Create dialog */}
      <UserFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        isPending={createMutation.isPending}
        onSubmit={handleCreate}
      />

      {/* Edit dialog */}
      <UserFormDialog
        open={editOpen}
        onOpenChange={(v) => {
          setEditOpen(v)
          if (!v) setSelectedUser(null)
        }}
        user={selectedUser}
        isPending={updateMutation.isPending}
        onSubmit={handleEdit}
      />

      {/* Detail dialog */}
      <UserDetailDialog
        open={detailOpen}
        onOpenChange={(v) => {
          setDetailOpen(v)
          if (!v) setSelectedUser(null)
        }}
        userId={selectedUser?.id ?? null}
      />

      {/* Single delete confirmation */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(v) => {
          setDeleteOpen(v)
          if (!v) setSelectedUser(null)
        }}
        title="Delete User"
        description={`Are you sure you want to delete user "${selectedUser?.username}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={deleteMutation.isPending}
      />

      {/* Bulk delete confirmation */}
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title="Delete Selected Users"
        description={`Are you sure you want to delete ${selectedCount} user${selectedCount !== 1 ? 's' : ''}? This action cannot be undone.`}
        confirmLabel="Delete All"
        variant="destructive"
        onConfirm={handleBulkDelete}
        isLoading={bulkDeleteMutation.isPending}
      />
    </Main>
  )
}
