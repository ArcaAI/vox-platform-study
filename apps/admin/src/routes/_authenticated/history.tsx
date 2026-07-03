import { Button } from '@arcaai/ui/button';
import { HistoryTimelineList } from '@arcaai/ui/components/timeline';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import type { ContextItem } from '@arcaai/vox';
import { useAdminConsultations, useArca } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { format } from 'date-fns';
import { RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { mapContextItem, mergeResolvedMedia } from '@/features/history/map-context-item';
import { useAppDensity } from '@/providers/density-provider';

export const Route = createFileRoute('/_authenticated/history')({
  component: HistoryPage,
});

function consultationLabel(c: { id: string; status?: string; appointmentDate?: string; createdAt?: string; patientId?: string }): string {
  const when = c.appointmentDate ?? c.createdAt;
  const date = when ? safeFormat(when) : '';
  const parts = [`#${c.id.slice(0, 8)}`, c.patientId ? `patient ${c.patientId.slice(0, 6)}` : null, c.status, date].filter(Boolean);
  return parts.join('  ·  ');
}

function safeFormat(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : format(d, 'd MMM yyyy');
}

function HistoryPage() {
  const consults = useAdminConsultations();
  const { session, context } = useArca();
  const { density } = useAppDensity();

  const [selectedId, setSelectedId] = useState<string>('');
  /**
   * Media-enriched context items from `GET /consultations/:id/context` (TASK-375).
   * The store's `context.items` arrive via the consultation GET and are NOT
   * media-resolved, so we fetch the enriched list separately and merge the
   * presigned `url` / `mimeType` / `thumbnailUrl` onto them by id (below).
   */
  const [resolvedItems, setResolvedItems] = useState<ContextItem[]>([]);

  useEffect(() => {
    void consults.list({ limit: 50 }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-select the first consultation once the list loads.
  useEffect(() => {
    if (!selectedId && consults.consultations.length > 0) {
      setSelectedId(consults.consultations[0].id);
    }
  }, [consults.consultations, selectedId]);

  useEffect(() => {
    setResolvedItems([]);
    if (selectedId) void session.load(selectedId).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Once the selected consultation is in the store, fetch its media-enriched
  // context items so the timeline can resolve presigned media URLs. Keyed on the
  // loaded consultation id so `context.getItems()` runs with a fresh closure.
  const loadedId = session.consultation?.id;
  useEffect(() => {
    if (!loadedId || loadedId !== selectedId) return;
    let cancelled = false;
    void context
      .getItems()
      .then((items) => {
        if (!cancelled) setResolvedItems(items);
      })
      .catch(() => {
        if (!cancelled) setResolvedItems([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedId, selectedId]);

  // Merge resolved media onto the store items (preserving order); degrades to the
  // plain items when enrichment is unavailable.
  const timelineItems = useMemo(() => mergeResolvedMedia(context.items, resolvedItems), [context.items, resolvedItems]);

  const hasConsultations = consults.consultations.length > 0;

  return (
    <div>
      <PageHeader
        title="Consultation History"
        description="A reverse-chronological, content-type-aware timeline of a consultation's context items (notes, transcripts, summaries, attachments)."
        actions={
          <Button variant="outline" size="sm" onClick={() => void consults.list({ limit: 50 }).catch(() => undefined)}>
            <RotateCcw className="size-4" />
            Refresh
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={selectedId} onValueChange={setSelectedId} disabled={!hasConsultations}>
          <SelectTrigger className="w-full max-w-md" aria-label="Select consultation">
            <SelectValue placeholder={consults.isLoading ? 'Loading consultations…' : 'Select a consultation'} />
          </SelectTrigger>
          <SelectContent>
            {consults.consultations.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {consultationLabel(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {consults.error && !hasConsultations ? (
        <p className="text-sm text-muted-foreground">
          Couldn’t load consultations ({consults.error.message}). Admin consultation access requires the <code>Consultation</code> manage permission.
        </p>
      ) : null}

      <HistoryTimelineList
        aria-label="Consultation context timeline"
        items={timelineItems}
        mapItem={mapContextItem}
        density={density}
        isLoading={session.isLoading && context.items.length === 0}
        error={session.error ?? undefined}
        onRetry={() => selectedId && void session.load(selectedId).catch(() => undefined)}
        height={620}
      />
    </div>
  );
}
