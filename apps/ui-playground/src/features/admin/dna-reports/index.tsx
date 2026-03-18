import { Badge } from '@arcaai/ui/badge'
import { type MultiColumnConfig, type MultiColumnContentConfig, MultiColumnLayout, type MultiColumnState } from '@arcaai/ui/multi-column-layout'
import { Building2, GitCompare, History, User as UserIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Main } from '@/components/layout/main'
import { VersionDiffPanel } from '@/components/version-diff-panel'
import type { DnaStyleVersion } from '@/features/dna-writing-style/api/dna-writing-styles'
import { useAuthStore } from '@/store/auth-store'
import {
  useDnaReportVersions,
  useRefreshDnaReportVersions,
  useRefreshTenantDnaReportData,
  useTenantDnaReportData,
} from '../api/dna-reports'
import { type Tenant, useTenant, useTenantsInfinite } from '../api/tenants'
import { type AdminUser } from '../api/users'

const ATTR_KEYS = [
  'tone',
  'vocabulary',
  'structure',
  'formality',
  'sentenceLength',
  'medicalTermUsage',
  'abbreviationStyle',
] as const

const ATTR_LABEL: Record<string, string> = {
  tone: 'Tone',
  vocabulary: 'Vocabulary',
  structure: 'Structure',
  formality: 'Formality',
  sentenceLength: 'Sentence Length',
  medicalTermUsage: 'Medical Terms',
  abbreviationStyle: 'Abbreviations',
}

const EMPTY_VERSIONS: DnaStyleVersion[] = []

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

function relativeTime(dateStr?: string | null): string {
  if (!dateStr) return '—'
  const ms = Date.now() - new Date(dateStr).getTime()
  const sec = Math.floor(ms / 1000)
  const min = Math.floor(sec / 60)
  const hr = Math.floor(min / 60)
  const day = Math.floor(hr / 24)
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (day > 30) return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  if (day >= 1) return rtf.format(-day, 'day')
  if (hr >= 1) return rtf.format(-hr, 'hour')
  if (min >= 1) return rtf.format(-min, 'minute')
  return rtf.format(-sec, 'second')
}

function displayUserName(user: AdminUser): string {
  const firstName = user.UserProfile?.firstName?.trim()
  const lastName = user.UserProfile?.lastName?.trim()
  if (firstName || lastName) return [firstName, lastName].filter(Boolean).join(' ')
  return user.username
}

export default function DnaReportsAdminPage() {
  const roles = useAuthStore((s: { user?: { roles?: string[] } | null }) => s.user?.roles ?? [])
  const tenantId = useAuthStore((s: { tenantId: string }) => s.tenantId)
  const tenantName = useAuthStore((s: { tenantName: string }) => s.tenantName)
  const setTenant = useAuthStore((s: { setTenant: (tenantId: string, tenantName?: string) => void }) => s.setTenant)

  const isSuperOrGlobalAdmin = roles.includes('SUPER_ADMIN') || roles.includes('GLOBAL_ADMIN')
  const [selectedTenantId, setSelectedTenantId] = useState(tenantId || '')
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [selectedVersionIds, setSelectedVersionIds] = useState<string[]>([])
  const refreshTenantData = useRefreshTenantDnaReportData()
  const refreshVersions = useRefreshDnaReportVersions()

  const {
    data: tenantsPages,
    isLoading: tenantsLoading,
    hasNextPage: tenantsHasMore,
    fetchNextPage: fetchNextTenants,
    isFetchingNextPage: tenantsLoadingMore,
    refetch: refetchTenants,
  } = useTenantsInfinite(25, { enabled: isSuperOrGlobalAdmin })

  const {
    data: currentTenant,
    isLoading: currentTenantLoading,
    refetch: refetchCurrentTenant,
  } = useTenant(tenantId || '', { enabled: !isSuperOrGlobalAdmin && !!tenantId })

  const tenantList = useMemo(() => {
    if (isSuperOrGlobalAdmin) {
      return tenantsPages?.pages.flatMap((page) => page.data) ?? []
    }
    if (currentTenant) return [currentTenant]
    if (!tenantId) return []
    return [{
      id: tenantId,
      name: tenantName || tenantId,
      key: tenantId,
      resourceStatus: 'ENABLED',
      createdAt: '',
      updatedAt: '',
    } as Tenant]
  }, [currentTenant, isSuperOrGlobalAdmin, tenantId, tenantName, tenantsPages])

  useEffect(() => {
    if (isSuperOrGlobalAdmin) {
      return
    }
    if (tenantId && tenantId !== selectedTenantId) {
      setSelectedTenantId(tenantId)
    }
  }, [isSuperOrGlobalAdmin, selectedTenantId, tenantId])

  const effectiveTenantId = isSuperOrGlobalAdmin ? selectedTenantId : tenantId

  const tenantDataQuery = useTenantDnaReportData(effectiveTenantId)

  const users = tenantDataQuery.data?.users ?? []
  const reports = tenantDataQuery.data?.reports ?? []

  const selectedReport = useMemo(() => {
    if (!selectedUserId) return null
    const reportsByUser = reports
      .filter((report) => report.doctorId === selectedUserId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    return reportsByUser[0] ?? null
  }, [reports, selectedUserId])

  const versionsQuery = useDnaReportVersions(effectiveTenantId, selectedReport?.id || '')

  const versions = versionsQuery.data ?? EMPTY_VERSIONS

  const styleCountByUserId = useMemo(() => {
    const counts = new Map<string, number>()
    for (const report of reports) {
      counts.set(report.doctorId, (counts.get(report.doctorId) ?? 0) + 1)
    }
    return counts
  }, [reports])

  const selectedVersions = useMemo(
    () => selectedVersionIds
      .map((id) => versions.find((version) => version.id === id))
      .filter((version): version is DnaStyleVersion => Boolean(version)),
    [selectedVersionIds, versions],
  )

  useEffect(() => {
    setSelectedUserId((prev) => (prev === null ? prev : null))
    setSelectedVersionIds((prev) => (prev.length === 0 ? prev : []))
  }, [selectedTenantId])

  useEffect(() => {
    setSelectedVersionIds((prev) => (prev.length === 0 ? prev : []))
  }, [selectedUserId])

  useEffect(() => {
    setSelectedVersionIds((prev) => {
      const next = prev.filter((id) => versions.some((version) => version.id === id))
      const isUnchanged = next.length === prev.length && next.every((id, index) => id === prev[index])
      return isUnchanged ? prev : next
    })
  }, [versions])

  useEffect(() => {
    if (!selectedUserId) return
    const stillExists = users.some((user) => user.id === selectedUserId)
    if (!stillExists) {
      setSelectedUserId(null)
      setSelectedVersionIds([])
    }
  }, [selectedUserId, users])

  const handleTenantSelect = useCallback((tenantSelectionId: string) => {
    if (!isSuperOrGlobalAdmin) return
    if (tenantSelectionId === selectedTenantId) return
    setSelectedTenantId(tenantSelectionId)
    const tenant = tenantList.find((item) => item.id === tenantSelectionId)
    setTenant(tenantSelectionId, tenant?.name)
  }, [isSuperOrGlobalAdmin, selectedTenantId, setTenant, tenantList])

  const handleUserSelect = useCallback((userId: string) => {
    if (userId === selectedUserId) return
    setSelectedUserId(userId)
  }, [selectedUserId])

  const handleVersionSelect = useCallback((versionId: string) => {
    setSelectedVersionIds((prev) => {
      if (prev.includes(versionId)) return prev.filter((id) => id !== versionId)
      if (prev.length >= 2) return [prev[1]!, versionId]
      return [...prev, versionId]
    })
  }, [])

  const tenantColumn: MultiColumnConfig<Tenant> = {
    id: 'tenants',
    title: 'Tenants',
    subtitle: isSuperOrGlobalAdmin ? 'Select a tenant context' : 'Current tenant',
    width: '220px',
    showItemCount: true,
    keyExtractor: (tenant: Tenant) => tenant.id,
    estimateItemSize: 62,
    onRefresh: () => {
      if (isSuperOrGlobalAdmin) {
        void refetchTenants()
      } else {
        void refetchCurrentTenant()
      }
    },
    emptyTitle: 'No tenants available',
    emptyDescription: 'No tenant records were returned.',
    emptyIcon: <Building2 className="text-muted-foreground size-8" />,
    renderItem: (tenant: Tenant) => (
      <div className="flex min-w-0 items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{tenant.name}</p>
          <p className="text-muted-foreground truncate text-xs">{tenant.key}</p>
        </div>
      </div>
    ),
  }

  const tenantState: MultiColumnState<Tenant> = {
    data: tenantList,
    isLoading: isSuperOrGlobalAdmin ? tenantsLoading : currentTenantLoading,
    selectedId: effectiveTenantId || null,
    onSelect: handleTenantSelect,
    hasMore: isSuperOrGlobalAdmin ? !!tenantsHasMore : false,
    onLoadMore: isSuperOrGlobalAdmin ? () => void fetchNextTenants() : undefined,
    isLoadingMore: isSuperOrGlobalAdmin ? tenantsLoadingMore : false,
  }

  const usersColumn: MultiColumnConfig<AdminUser> = {
    id: 'users',
    title: 'Tenant Users',
    subtitle: selectedTenantId ? `${users.length} users` : 'Select a tenant',
    width: '260px',
    showItemCount: true,
    onRefresh: () => {
      if (!effectiveTenantId) return
      void refreshTenantData(effectiveTenantId)
    },
    emptyTitle: effectiveTenantId ? 'No users found' : 'Select a tenant',
    emptyDescription: effectiveTenantId
      ? 'No users are available in this tenant.'
      : 'Pick a tenant to load users.',
    emptyIcon: <UserIcon className="text-muted-foreground size-8" />,
    keyExtractor: (user: AdminUser) => user.id,
    estimateItemSize: 72,
    renderItem: (user: AdminUser) => {
      const styleCount = styleCountByUserId.get(user.id) ?? 0
      return (
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{displayUserName(user)}</p>
            <p className="text-muted-foreground truncate text-xs">{user.email ?? user.username}</p>
          </div>
          <Badge variant={styleCount > 0 ? 'default' : 'outline'} className="shrink-0 text-[10px]">
            {styleCount} styles
          </Badge>
        </div>
      )
    },
  }

  const usersState: MultiColumnState<AdminUser> = {
    data: users,
    isLoading: tenantDataQuery.isLoading || tenantDataQuery.isFetching,
    enabled: !!effectiveTenantId,
    selectedId: selectedUserId,
    onSelect: handleUserSelect,
  }

  const versionsColumn: MultiColumnConfig<DnaStyleVersion> = {
    id: 'versions',
    title: 'Report Versions',
    subtitle: selectedUserId
      ? selectedReport
        ? `${versions.length} versions`
        : 'No report for selected user'
      : 'Select a user',
    width: '220px',
    showItemCount: true,
    onRefresh: () => {
      if (!effectiveTenantId || !selectedReport?.id) return
      void refreshVersions(effectiveTenantId, selectedReport.id)
    },
    emptyTitle: !selectedUserId
      ? 'Select a user'
      : !selectedReport
        ? 'No report found'
        : 'No versions found',
    emptyDescription: !selectedUserId
      ? 'Pick a user to view report versions.'
      : !selectedReport
        ? 'This user has no DNA report yet.'
        : 'No versions are available for this report.',
    emptyIcon: <History className="text-muted-foreground size-8" />,
    keyExtractor: (version: DnaStyleVersion) => version.id,
    estimateItemSize: 70,
    renderItem: (version: DnaStyleVersion) => (
      <div className="flex flex-col gap-1 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="outline" className="text-xs">v{version.versionNumber}</Badge>
          <span className="text-muted-foreground text-[10px]">{relativeTime(version.createdAt)}</span>
        </div>
        {version.changeReason && (
          <p className="text-muted-foreground truncate text-xs italic">{version.changeReason}</p>
        )}
      </div>
    ),
  }

  const versionsState: MultiColumnState<DnaStyleVersion> = {
    data: versions,
    isLoading: versionsQuery.isLoading || versionsQuery.isFetching,
    enabled: !!selectedUserId && !!selectedReport,
    selectedId: selectedVersionIds[0] ?? null,
    selectedIds: selectedVersionIds,
    onSelect: handleVersionSelect,
  }

  const detailColumn: MultiColumnContentConfig = {
    type: 'content',
    id: 'detail',
    title: selectedVersions.length === 2 ? 'Version Diff' : 'Version Detail',
    subtitle: selectedVersions.length === 2
      ? `${selectedVersions[0]?.versionNumber ?? ''} vs ${selectedVersions[1]?.versionNumber ?? ''}`
      : selectedVersions.length === 1
        ? `v${selectedVersions[0]!.versionNumber}`
        : 'Select one or two versions',
    onRefresh: () => {
      if (!effectiveTenantId || !selectedReport?.id || selectedVersionIds.length === 0) return
      void refreshVersions(effectiveTenantId, selectedReport.id)
    },
    emptyTitle: 'Select versions',
    emptyDescription: 'Select one version for detail or two versions for diff.',
    emptyIcon: <GitCompare className="text-muted-foreground size-8" />,
    renderContent: () => {
      if (selectedVersions.length === 0) {
        return null
      }

      if (selectedVersions.length === 2) {
        const [left, right] = [...selectedVersions].sort((a, b) => a.versionNumber - b.versionNumber)
        const leftAttrs = left.reportData ?? {}
        const rightAttrs = right.reportData ?? {}
        return (
          <VersionDiffPanel
            left={{ versionNumber: left.versionNumber, date: left.createdAt, changeReason: left.changeReason }}
            right={{ versionNumber: right.versionNumber, date: right.createdAt, changeReason: right.changeReason }}
            sections={[{
              label: 'Style Description',
              oldText: left.styleText || '',
              newText: right.styleText || '',
            }]}
            attributes={ATTR_KEYS.map((key) => ({
              key,
              label: ATTR_LABEL[key],
              oldValue: String(leftAttrs[key] ?? ''),
              newValue: String(rightAttrs[key] ?? ''),
            }))}
          />
        )
      }

      const version = selectedVersions[0]!
      const attrs = version.reportData ?? {}
      return (
        <div className="flex flex-col gap-4 p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold">Version {version.versionNumber}</h3>
              <p className="text-muted-foreground text-xs">{fmtDate(version.createdAt)}</p>
            </div>
            <Badge variant="outline">{selectedReport?.isLatest ? 'Latest report' : 'Historical'}</Badge>
          </div>
          {version.styleText && (
            <div className="rounded-lg border p-3">
              <h4 className="mb-2 text-sm font-semibold">Style Description</h4>
              <p className="text-sm whitespace-pre-wrap">{version.styleText}</p>
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {ATTR_KEYS.map((key) => (
              <div key={key} className="rounded-md border p-2">
                <p className="text-muted-foreground text-xs">{ATTR_LABEL[key]}</p>
                <p className="text-sm font-medium">{String(attrs[key] ?? '—')}</p>
              </div>
            ))}
          </div>
          {version.changeReason && (
            <div className="rounded-lg border p-3">
              <h4 className="mb-1 text-sm font-semibold">Change Reason</h4>
              <p className="text-sm">{version.changeReason}</p>
            </div>
          )}
        </div>
      )
    },
  }

  const detailState: MultiColumnState<never> = {
    data: [],
    isLoading: false,
    enabled: !!selectedUserId,
    selectedId: null,
    onSelect: () => {},
  }

  return (
    <Main>
      <div className="mb-4">
        <h2 className="text-2xl font-bold tracking-tight">DNA Writing Style Reports</h2>
        <p className="text-muted-foreground mt-1">
          Review tenant-level DNA writing style reports, inspect versions, and compare two versions side-by-side.
        </p>
      </div>

      <MultiColumnLayout
        columns={[tenantColumn, usersColumn, versionsColumn, detailColumn]}
        columnStates={[tenantState, usersState, versionsState, detailState]}
        height="calc(100vh - 12rem)"
      />
    </Main>
  )
}
