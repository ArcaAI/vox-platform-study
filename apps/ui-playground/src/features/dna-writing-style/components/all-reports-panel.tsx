import { cn } from '@/lib/utils'
import { Badge } from '@arcaai/ui/badge'
import {
  MultiColumnLayout,
  type MultiColumnConfig,
  type MultiColumnDetailConfig,
  type MultiColumnDetailState,
  type MultiColumnState,
} from '@arcaai/ui/multi-column-layout'
import { Separator } from '@arcaai/ui/separator'
import { Switch } from '@arcaai/ui/switch'
import {
  BookOpen,
  Clock,
  Copy,
  Dna,
  FileText,
  History,
  Sparkles,
  User as UserIcon,
} from 'lucide-react'
import React from 'react'
import type { AdminUser } from '../../admin/api/users'
import type { DnaReport, DnaStyleVersion } from '../api/dna-writing-styles'

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

function StyleAttributeCard({
  label,
  value,
  icon,
}: {
  label: string
  value?: string | null
  icon: React.ReactNode
}) {
  return (
    <div className="bg-muted/30 rounded-lg border p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p className="text-sm font-medium">{value || '—'}</p>
    </div>
  )
}

export interface AllReportsPanelProps {
  reports: DnaReport[]
  versions: DnaStyleVersion[]
  isLoadingReports: boolean
  isLoadingVersions: boolean
  selectedReportId: string | null
  selectedVersionId: string | null
  onSelectReport: (reportId: string) => void
  onSelectVersion: (versionId: string) => void
  doctors: AdminUser[]
  onToggleReportStatus?: (report: DnaReport) => void
  isTogglingStatus?: boolean
  reportsHasMore?: boolean
  onLoadMoreReports?: () => void
  reportsLoadingMore?: boolean
  onRefreshReports?: () => void
  onRefreshVersions?: () => void
}

export function AllReportsPanel({
  reports,
  versions,
  isLoadingReports,
  isLoadingVersions,
  selectedReportId,
  selectedVersionId,
  onSelectReport,
  onSelectVersion,
  doctors,
  onToggleReportStatus,
  isTogglingStatus,
  reportsHasMore,
  onLoadMoreReports,
  reportsLoadingMore,
  onRefreshReports,
  onRefreshVersions,
}: AllReportsPanelProps) {
  const selectedVersion = selectedVersionId
    ? versions.find((v) => v.id === selectedVersionId) ?? null
    : null

  const selectedReport = selectedReportId
    ? reports.find((r) => r.id === selectedReportId) ?? null
    : null

  const resolveDoctorName = (doctorId: string) => {
    const doc = doctors.find((d) => d.id === doctorId)
    return doc?.username ?? doctorId.slice(0, 12) + '…'
  }

  // ---- Column configurations ------------------------------------------------

  const reportsColumn: MultiColumnConfig<DnaReport> = {
    id: 'reports',
    title: 'Reports',
    showItemCount: true,
    onRefresh: onRefreshReports,
    skeletonCount: 5,
    skeletonHeight: 'h-16',
    estimateItemSize: 88,
    emptyIcon: <Dna className="size-5" />,
    emptyTitle: 'No reports found',
    emptyDescription: 'No DNA writing style reports exist yet.',
    keyExtractor: (r: DnaReport) => r.id,
    renderItem: (report: DnaReport) => {
      const isEnabled = (report.resourceStatus ?? 'ENABLED').toUpperCase() === 'ENABLED'
      return (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className={cn('truncate text-sm font-medium', !isEnabled && 'text-muted-foreground line-through')}>
                {resolveDoctorName(report.doctorId)}
              </p>
              <p className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]">
                {report.id.slice(0, 12)}…
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Switch
                checked={isEnabled}
                onCheckedChange={() => onToggleReportStatus?.(report)}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                disabled={isTogglingStatus}
                size="sm"
              />
              <div className="flex flex-col items-end gap-1">
                <Badge variant="outline" className="font-mono text-[10px]">
                  v{report.currentVersionNumber}
                </Badge>
                {report.isLatest && (
                  <Badge variant="default" className="text-[10px]">Latest</Badge>
                )}
              </div>
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            {report.reportData?.tone && (
              <Badge variant="secondary" className="text-[10px]">
                {report.reportData.tone}
              </Badge>
            )}
            {report.reportData?.formality && (
              <Badge variant="secondary" className="text-[10px]">
                {report.reportData.formality}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-1 text-[11px]">
            {relativeTime(report.updatedAt)}
          </p>
        </>
      )
    },
  }

  const versionsColumn: MultiColumnConfig<DnaStyleVersion> = {
    id: 'versions',
    title: 'Versions',
    onRefresh: onRefreshVersions,
    subtitle: selectedReport
      ? `${resolveDoctorName(selectedReport.doctorId)} · ${versions.length} versions`
      : 'Select a report to view versions',
    skeletonCount: 3,
    skeletonHeight: 'h-20',
    estimateItemSize: 72,
    emptyIcon: <History className="size-5" />,
    emptyTitle: selectedReportId
      ? 'No versions found'
      : 'No report selected',
    emptyDescription: selectedReportId
      ? 'No versions found for this report.'
      : 'Select a report to view its version history.',
    keyExtractor: (v: DnaStyleVersion) => v.id,
    renderItem: (version: DnaStyleVersion) => (
      <>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-xs">
              v{version.versionNumber}
            </Badge>
            {version.versionNumber === (selectedReport?.currentVersionNumber ?? 0) && (
              <Badge variant="default" className="text-[10px]">Current</Badge>
            )}
          </div>
          <span className="text-muted-foreground text-[11px]">
            {relativeTime(version.createdAt)}
          </span>
        </div>
        {version.changeReason && (
          <p className="text-muted-foreground mt-1.5 text-xs line-clamp-2">
            {version.changeReason}
          </p>
        )}
        {version.changedBy && (
          <p className="text-muted-foreground/70 mt-0.5 text-[11px]">
            by {version.changedBy}
          </p>
        )}
      </>
    ),
  }

  // ---- Detail column --------------------------------------------------------

  const detailColumnDef: MultiColumnDetailConfig = {
    id: 'detail',
    title: 'Detail',
    subtitle: selectedVersion
      ? `Version ${selectedVersion.versionNumber} · ${fmtDate(selectedVersion.createdAt)}`
      : 'Select a version to view details',
    emptyIcon: <FileText className="size-5" />,
    emptyTitle: 'No version selected',
    emptyDescription: 'Select a version to view its full details.',
  }

  const detailContent = selectedVersion ? (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex items-center gap-3">
        <div className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-full">
          <Dna className="size-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h4 className="text-base font-semibold">
              Version {selectedVersion.versionNumber}
            </h4>
            {selectedVersion.versionNumber === (selectedReport?.currentVersionNumber ?? 0) && (
              <Badge variant="default" className="text-[10px]">Current</Badge>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            {fmtDate(selectedVersion.createdAt)}
          </p>
        </div>
      </div>

      {selectedVersion.changeReason && (
        <div className="bg-muted/30 rounded-lg border p-3">
          <p className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-wider">
            Change Reason
          </p>
          <p className="text-sm">{selectedVersion.changeReason}</p>
          {selectedVersion.changedBy && (
            <p className="text-muted-foreground mt-1 text-xs">
              Changed by: {selectedVersion.changedBy}
            </p>
          )}
        </div>
      )}

      {selectedVersion.styleText && (
        <div>
          <h5 className="mb-2 flex items-center gap-2 text-sm font-medium">
            <FileText className="size-4" />
            Style Description
          </h5>
          <div className="bg-muted/20 rounded-lg border p-4">
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {selectedVersion.styleText}
            </p>
          </div>
        </div>
      )}

      {selectedVersion.reportData && (
        <div>
          <h5 className="mb-3 flex items-center gap-2 text-sm font-medium">
            <BookOpen className="size-4" />
            Style Attributes
          </h5>
          <div className="grid grid-cols-2 gap-2">
            {selectedVersion.reportData.tone && (
              <StyleAttributeCard
                label="Tone"
                value={selectedVersion.reportData.tone}
                icon={<Sparkles className="size-3.5" />}
              />
            )}
            {selectedVersion.reportData.vocabulary && (
              <StyleAttributeCard
                label="Vocabulary"
                value={selectedVersion.reportData.vocabulary}
                icon={<BookOpen className="size-3.5" />}
              />
            )}
            {selectedVersion.reportData.structure && (
              <StyleAttributeCard
                label="Structure"
                value={selectedVersion.reportData.structure as string}
                icon={<FileText className="size-3.5" />}
              />
            )}
            {selectedVersion.reportData.formality && (
              <StyleAttributeCard
                label="Formality"
                value={selectedVersion.reportData.formality}
                icon={<UserIcon className="size-3.5" />}
              />
            )}
            {selectedVersion.reportData.sentenceLength && (
              <StyleAttributeCard
                label="Sentence Length"
                value={selectedVersion.reportData.sentenceLength}
                icon={<Clock className="size-3.5" />}
              />
            )}
            {selectedVersion.reportData.medicalTermUsage && (
              <StyleAttributeCard
                label="Medical Terms"
                value={selectedVersion.reportData.medicalTermUsage}
                icon={<Dna className="size-3.5" />}
              />
            )}
            {selectedVersion.reportData.abbreviationStyle && (
              <StyleAttributeCard
                label="Abbreviations"
                value={selectedVersion.reportData.abbreviationStyle}
                icon={<Copy className="size-3.5" />}
              />
            )}
          </div>
        </div>
      )}

      <Separator />
      <div className="text-muted-foreground flex flex-col gap-1 text-xs">
        <p>Version ID: <span className="font-mono">{selectedVersion.id}</span></p>
        <p>Report ID: <span className="font-mono">{selectedVersion.dnaReportId}</span></p>
        {selectedReport && (
          <p>Doctor: {resolveDoctorName(selectedReport.doctorId)}</p>
        )}
      </div>
    </div>
  ) : null

  const detailState: MultiColumnDetailState = {
    hasSelection: !!selectedVersion,
    content: detailContent,
  }

  // ---- Column states --------------------------------------------------------

  const columnStates: MultiColumnState[] = [
    {
      data: reports,
      isLoading: isLoadingReports,
      selectedId: selectedReportId,
      onSelect: onSelectReport,
      hasMore: reportsHasMore,
      onLoadMore: onLoadMoreReports,
      isLoadingMore: reportsLoadingMore,
    },
    {
      data: versions,
      isLoading: isLoadingVersions,
      selectedId: selectedVersionId,
      onSelect: onSelectVersion,
      enabled: !!selectedReportId,
    },
  ]

  return (
    <MultiColumnLayout
      columns={[reportsColumn, versionsColumn]}
      columnStates={columnStates}
      detailColumn={detailColumnDef}
      detailState={detailState}
      height="calc(100vh - 20rem)"
    />
  )
}
