import { Badge } from '@arcaai/ui/badge';
import {
  MultiColumnLayout,
  type MultiColumnConfig,
  type MultiColumnDetailConfig,
  type MultiColumnDetailState,
  type MultiColumnState,
} from '@arcaai/ui/multi-column-layout';
import { Separator } from '@arcaai/ui/separator';
import { BookOpen, Clock, Copy, Dna, FileText, History, Sparkles, User as UserIcon } from 'lucide-react';
import React from 'react';
import type { DnaReport, DnaStyleVersion } from '../api/dna-writing-styles';

function relativeTime(dateStr?: string | null): string {
  if (!dateStr) return '—';
  const ms = Date.now() - new Date(dateStr).getTime();
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (day > 30) {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  if (day >= 1) return rtf.format(-day, 'day');
  if (hr >= 1) return rtf.format(-hr, 'hour');
  if (min >= 1) return rtf.format(-min, 'minute');
  return rtf.format(-sec, 'second');
}

function fmtDate(dateStr?: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StyleAttributeCard({ label, value, icon }: { label: string; value?: string | null; icon: React.ReactNode }) {
  return (
    <div className="bg-muted/30 rounded-lg border p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-sm font-medium">{value || '—'}</p>
    </div>
  );
}

export interface VersionsPanelProps {
  report: DnaReport;
  versions: DnaStyleVersion[];
  isLoadingVersions: boolean;
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string) => void;
  onRefreshVersions?: () => void;
}

export function VersionsPanel({ report, versions, isLoadingVersions, selectedVersionId, onSelectVersion, onRefreshVersions }: VersionsPanelProps) {
  const selectedVersion = selectedVersionId ? (versions.find((v) => v.id === selectedVersionId) ?? null) : null;

  const versionsColumn: MultiColumnConfig<DnaStyleVersion> = {
    id: 'versions',
    title: 'Version History',
    showItemCount: true,
    onRefresh: onRefreshVersions,
    subtitle: `${versions.length} version${versions.length !== 1 ? 's' : ''}`,
    skeletonCount: 3,
    skeletonHeight: 'h-20',
    estimateItemSize: 72,
    emptyIcon: <History className="size-5" />,
    emptyTitle: 'No versions yet',
    emptyDescription: 'Generate a writing style to create the first version.',
    keyExtractor: (v: DnaStyleVersion) => v.id,
    renderItem: (version: DnaStyleVersion) => (
      <>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-xs">
              v{version.versionNumber}
            </Badge>
            {version.versionNumber === report.currentVersionNumber && (
              <Badge variant="default" className="text-[10px]">
                Current
              </Badge>
            )}
          </div>
          <span className="text-muted-foreground text-[11px]">{relativeTime(version.createdAt)}</span>
        </div>
        {version.changeReason && <p className="text-muted-foreground mt-1.5 text-xs line-clamp-2">{version.changeReason}</p>}
        {version.changedBy && <p className="text-muted-foreground/70 mt-0.5 text-[11px]">by {version.changedBy}</p>}
      </>
    ),
  };

  const detailColumnDef: MultiColumnDetailConfig = {
    id: 'detail',
    title: 'Detail',
    subtitle: selectedVersion
      ? `Version ${selectedVersion.versionNumber} · ${fmtDate(selectedVersion.createdAt)}`
      : 'Select a version to view details',
    emptyIcon: <FileText className="size-5" />,
    emptyTitle: 'No version selected',
    emptyDescription: 'Select a version to view its full details.',
  };

  const detailContent = selectedVersion ? (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex items-center gap-3">
        <div className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-full">
          <Dna className="size-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h4 className="text-base font-semibold">Version {selectedVersion.versionNumber}</h4>
            {selectedVersion.versionNumber === report.currentVersionNumber && (
              <Badge variant="default" className="text-[10px]">
                Current
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground text-xs">{fmtDate(selectedVersion.createdAt)}</p>
        </div>
      </div>

      {selectedVersion.changeReason && (
        <div className="bg-muted/30 rounded-lg border p-3">
          <p className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-wider">Change Reason</p>
          <p className="text-sm">{selectedVersion.changeReason}</p>
          {selectedVersion.changedBy && <p className="text-muted-foreground mt-1 text-xs">Changed by: {selectedVersion.changedBy}</p>}
        </div>
      )}

      {selectedVersion.styleText && (
        <div>
          <h5 className="mb-2 flex items-center gap-2 text-sm font-medium">
            <FileText className="size-4" />
            Style Description
          </h5>
          <div className="bg-muted/20 rounded-lg border p-4">
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{selectedVersion.styleText}</p>
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
              <StyleAttributeCard label="Tone" value={selectedVersion.reportData.tone} icon={<Sparkles className="size-3.5" />} />
            )}
            {selectedVersion.reportData.vocabulary && (
              <StyleAttributeCard label="Vocabulary" value={selectedVersion.reportData.vocabulary} icon={<BookOpen className="size-3.5" />} />
            )}
            {selectedVersion.reportData.structure && (
              <StyleAttributeCard label="Structure" value={selectedVersion.reportData.structure as string} icon={<FileText className="size-3.5" />} />
            )}
            {selectedVersion.reportData.formality && (
              <StyleAttributeCard label="Formality" value={selectedVersion.reportData.formality} icon={<UserIcon className="size-3.5" />} />
            )}
            {selectedVersion.reportData.sentenceLength && (
              <StyleAttributeCard label="Sentence Length" value={selectedVersion.reportData.sentenceLength} icon={<Clock className="size-3.5" />} />
            )}
            {selectedVersion.reportData.medicalTermUsage && (
              <StyleAttributeCard label="Medical Terms" value={selectedVersion.reportData.medicalTermUsage} icon={<Dna className="size-3.5" />} />
            )}
            {selectedVersion.reportData.abbreviationStyle && (
              <StyleAttributeCard label="Abbreviations" value={selectedVersion.reportData.abbreviationStyle} icon={<Copy className="size-3.5" />} />
            )}
          </div>
        </div>
      )}

      <Separator />
      <div className="text-muted-foreground flex flex-col gap-1 text-xs">
        <p>
          Version ID: <span className="font-mono">{selectedVersion.id}</span>
        </p>
        <p>
          Report ID: <span className="font-mono">{selectedVersion.dnaReportId}</span>
        </p>
      </div>
    </div>
  ) : null;

  const detailState: MultiColumnDetailState = {
    hasSelection: !!selectedVersion,
    content: detailContent,
  };

  const columnStates: MultiColumnState[] = [
    {
      data: versions,
      isLoading: isLoadingVersions,
      selectedId: selectedVersionId,
      onSelect: onSelectVersion,
    },
  ];

  return (
    <MultiColumnLayout
      columns={[versionsColumn]}
      columnStates={columnStates}
      detailColumn={detailColumnDef}
      detailState={detailState}
      height="calc(100vh - 20rem)"
    />
  );
}
