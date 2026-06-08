/**
 * ArtifactsPanel (TASK-330 P3, WS5).
 *
 * Lists everything captured on the consultation: raw+processed audio, the
 * transcript, work/case notes, lab/exam attachments, the drafted RAW_SUMMARY and
 * the SIGNED_NOTE. Reads context items + recordings via React Query with
 * skeleton / empty / error states and a manual refresh.
 */
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Skeleton } from '@arcaai/ui/skeleton';
import { formatDistanceToNow } from 'date-fns';
import { AlertCircle, FileAudio, FileText, FlaskConical, Layers, RefreshCw, ShieldCheck, StickyNote } from 'lucide-react';
import { useMemo } from 'react';
import { useContextItemsQuery, useRecordingsQuery } from '../api/queries';
import { LAB_RESULT_SUBTYPE } from '../constants';
import { artifactGroupFor } from '../lib/artifacts';
import type { AudioRecordingItem, WorkspaceContextItem } from '../types';

interface ArtifactsPanelProps {
  consultationId: string;
}

function relativeTime(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : formatDistanceToNow(new Date(t), { addSuffix: true });
}

function isLab(item: WorkspaceContextItem): boolean {
  return (item.metadata as { subType?: string } | null | undefined)?.subType === LAB_RESULT_SUBTYPE;
}

function ContextRow({ item }: { item: WorkspaceContextItem }) {
  return (
    <li className="flex items-start gap-2 rounded-md border p-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">
            {item.type}
          </Badge>
          {isLab(item) && (
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <FlaskConical className="size-3" />
              LAB
            </Badge>
          )}
          {item.status && <span className="text-muted-foreground text-[10px] uppercase">{item.status}</span>}
        </div>
        <p className="mt-0.5 truncate">{item.content}</p>
      </div>
      <span className="text-muted-foreground shrink-0 text-[11px]">{relativeTime(item.createdAt)}</span>
    </li>
  );
}

export function ArtifactsPanel({ consultationId }: ArtifactsPanelProps) {
  const contextQuery = useContextItemsQuery(consultationId);
  const recordingsQuery = useRecordingsQuery(consultationId);

  const grouped = useMemo(() => {
    const items = contextQuery.data ?? [];
    const groups: Record<string, WorkspaceContextItem[]> = { transcript: [], note: [], summary: [], attachment: [] };
    for (const item of items) {
      const key = artifactGroupFor(item.type);
      if (key === 'audio') continue; // audio shown from the recordings query
      (groups[key] ??= []).push(item);
    }
    return groups;
  }, [contextQuery.data]);

  const recordings = recordingsQuery.data ?? [];
  const isLoading = contextQuery.isLoading || recordingsQuery.isLoading;
  const isError = contextQuery.isError || recordingsQuery.isError;
  const totalContext = (contextQuery.data ?? []).length;

  const refresh = () => {
    void contextQuery.refetch();
    void recordingsQuery.refetch();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Layers className="size-4" />
          Artifacts &amp; storage
        </CardTitle>
        <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading} data-testid="artifacts-refresh">
          <RefreshCw className="mr-1 size-3.5" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {isError ? (
          <div className="text-destructive flex items-center gap-2 text-sm" data-testid="artifacts-error">
            <AlertCircle className="size-4 shrink-0" />
            Failed to load artifacts.
            <Button variant="outline" size="sm" className="ml-auto" onClick={refresh}>
              Retry
            </Button>
          </div>
        ) : isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : recordings.length === 0 && totalContext === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="artifacts-empty">
            No artifacts yet. Recordings, transcripts, notes, labs and the signed note will appear here as the visit progresses.
          </p>
        ) : (
          <>
            <ArtifactSection icon={<FileAudio className="size-4" />} title="Audio recordings" count={recordings.length}>
              <ul className="space-y-1.5">
                {recordings.map((r) => (
                  <RecordingRow key={r.id} recording={r} />
                ))}
              </ul>
            </ArtifactSection>

            <ArtifactSection icon={<FileText className="size-4" />} title="Transcript" count={grouped.transcript!.length}>
              <ul className="space-y-1.5">{grouped.transcript!.map((i) => <ContextRow key={i.id} item={i} />)}</ul>
            </ArtifactSection>

            <ArtifactSection icon={<ShieldCheck className="size-4" />} title="Drafts & signed notes" count={grouped.summary!.length + grouped.note!.filter((i) => i.type === 'SIGNED_NOTE').length}>
              <ul className="space-y-1.5">
                {[...grouped.summary!, ...grouped.note!.filter((i) => i.type === 'SIGNED_NOTE')].map((i) => (
                  <ContextRow key={i.id} item={i} />
                ))}
              </ul>
            </ArtifactSection>

            <ArtifactSection icon={<StickyNote className="size-4" />} title="Notes" count={grouped.note!.filter((i) => i.type !== 'SIGNED_NOTE').length}>
              <ul className="space-y-1.5">{grouped.note!.filter((i) => i.type !== 'SIGNED_NOTE').map((i) => <ContextRow key={i.id} item={i} />)}</ul>
            </ArtifactSection>

            <ArtifactSection icon={<FlaskConical className="size-4" />} title="Attachments & labs" count={grouped.attachment!.length}>
              <ul className="space-y-1.5">{grouped.attachment!.map((i) => <ContextRow key={i.id} item={i} />)}</ul>
            </ArtifactSection>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ArtifactSection({ icon, title, count, children }: { icon: React.ReactNode; title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h4 className="text-xs font-semibold uppercase tracking-wide">{title}</h4>
        <Badge variant="outline" className="text-[10px]">
          {count}
        </Badge>
      </div>
      {count === 0 ? <p className="text-muted-foreground pl-6 text-xs">None yet.</p> : children}
    </div>
  );
}

function RecordingRow({ recording }: { recording: AudioRecordingItem }) {
  const dual = Boolean(recording.rawMediaId || recording.processedMediaId);
  return (
    <li className="flex items-center gap-2 rounded-md border p-2.5 text-sm">
      <FileAudio className="text-muted-foreground size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">#{recording.sequenceNumber ?? '—'}</span>
          {recording.durationFormatted && <span className="text-muted-foreground text-xs">{recording.durationFormatted}</span>}
          {dual && (
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <Layers className="size-3" />
              Dual capture
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground truncate font-mono text-[11px]">
          {recording.rawMediaId ? `raw: ${recording.rawMediaId.slice(0, 8)} · ` : ''}
          {recording.processedMediaId ? `proc: ${recording.processedMediaId.slice(0, 8)} · ` : ''}
          {recording.mediaId.slice(0, 8)}
        </p>
      </div>
      <span className="text-muted-foreground shrink-0 text-[11px]">{relativeTime(recording.createdAt)}</span>
    </li>
  );
}
