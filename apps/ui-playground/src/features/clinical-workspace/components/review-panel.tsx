/**
 * ReviewPanel (TASK-330 P3, WS5).
 *
 * Loads the auto-drafted note's provenance, maps it into `ClinicalReviewData`,
 * and renders the REUSED `ReviewScreen` (linked-evidence, float-ungrounded,
 * click-to-inspect). Adds the playground's edit + sign-off wiring:
 *   - Edit  → `PATCH /consultations/:id/summary/:summaryId`
 *   - Sign  → `POST  /consultations/:id/summary/:ctxId/approve` (never auto-run)
 *
 * The provenance → review-data mapping is the unit-tested `mapProvenanceToReviewData`.
 */
import { ReviewScreen } from './review';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent } from '@arcaai/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@arcaai/ui/dialog';
import { Label } from '@arcaai/ui/label';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Textarea } from '@arcaai/ui/textarea';
import { useArcaStore, type AgenticClient, type SummaryApprovalResponse, type TranscriptSource } from '@arcaai/vox';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2, Pencil, RefreshCw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { approveNote, updateSummaryContent } from '../api/clinical-workspace.api';
import { clinicalWorkspaceKeys, useProvenanceQuery } from '../api/queries';
import type { DraftWaitStatus } from '../lib/draft-polling';
import { mapProvenanceToReviewData } from '../lib/provenance';
import { ManualHighlightSurface } from './highlightable-surface';

interface ReviewPanelProps {
  consultationId: string;
  /** Draft note context-item id (null until the harness has drafted one). */
  noteContextItemId: string | null;
  /** Current draft content (for the edit dialog). */
  noteContent?: string;
  transcripts: TranscriptSource[];
  /** Draft-readiness polling status (drives the "generating draft…" waiting state). */
  draftStatus?: DraftWaitStatus;
  /** Manual re-check of the draft (used by the timed-out state). */
  onRefreshDraft?: () => void;
}

export function ReviewPanel({ consultationId, noteContextItemId, noteContent, transcripts, draftStatus, onRefreshDraft }: ReviewPanelProps) {
  const apiClient = useArcaStore((s: { apiClient: AgenticClient | null }) => s.apiClient);
  const queryClient = useQueryClient();
  const provenanceQuery = useProvenanceQuery(consultationId, noteContextItemId);

  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState(noteContent ?? '');
  const [saving, setSaving] = useState(false);

  if (!noteContextItemId) {
    // Recording stopped → the harness is drafting asynchronously; poll-driven
    // waiting states keep the clinician informed instead of a bare empty panel.
    if (draftStatus === 'generating') {
      return (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center" data-testid="review-generating">
            <Sparkles className="text-violet-500 size-6 animate-pulse" />
            <p className="text-sm font-medium">Generating the SOAP draft…</p>
            <p className="text-muted-foreground max-w-sm text-sm">
              The documentation harness is drafting the note with sentence-level provenance. This updates automatically — no need to refresh.
            </p>
            <div className="w-full max-w-sm space-y-2 pt-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </CardContent>
        </Card>
      );
    }
    if (draftStatus === 'timed-out') {
      // TASK-342 R3 — distinguish "nothing was captured" from "harness still
      // running". When the poll times out with no transcript persisted (the GAP #1
      // failure mode), say so plainly with a retry instead of an open-ended
      // "still generating" message that never resolves.
      if (transcripts.length === 0) {
        return (
          <Card>
            <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center" data-testid="review-no-transcript">
              <AlertCircle className="text-muted-foreground size-6" />
              <p className="text-sm font-medium">No transcript was captured for this visit</p>
              <p className="text-muted-foreground max-w-sm text-sm">
                The documentation harness needs a transcript to draft the SOAP note. Record (or re-record) the visit so a transcript is captured, then
                check again.
              </p>
              {onRefreshDraft && (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={onRefreshDraft} data-testid="review-no-transcript-refresh">
                  <RefreshCw className="size-3.5" />
                  Check again
                </Button>
              )}
            </CardContent>
          </Card>
        );
      }
      return (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center" data-testid="review-timeout">
            <AlertCircle className="text-muted-foreground size-6" />
            <p className="text-sm font-medium">The draft is taking longer than expected</p>
            <p className="text-muted-foreground max-w-sm text-sm">
              The harness may still be running (it needs Temporal + SMR up). You can keep waiting and check again manually.
            </p>
            {onRefreshDraft && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={onRefreshDraft} data-testid="review-timeout-refresh">
                <RefreshCw className="size-3.5" />
                Check again
              </Button>
            )}
          </CardContent>
        </Card>
      );
    }
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center" data-testid="review-empty">
          <p className="text-muted-foreground max-w-sm text-sm">
            No draft note yet. Stop the recording to let the documentation harness generate the SOAP draft, then review and sign it here.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (provenanceQuery.isLoading) {
    return (
      <div className="space-y-3" data-testid="review-skeleton">
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (provenanceQuery.isError || !provenanceQuery.data) {
    return (
      <Card className="border-destructive/50">
        <CardContent className="flex items-center gap-3 p-4" data-testid="review-error">
          <AlertCircle className="text-destructive size-5 shrink-0" />
          <p className="text-destructive text-sm">Failed to load the draft note provenance.</p>
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => void provenanceQuery.refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const data = mapProvenanceToReviewData({
    provenance: provenanceQuery.data,
    consultationId,
    noteContextItemId,
    transcripts,
  });

  const handleApprove = async (noteId: string): Promise<SummaryApprovalResponse> => {
    if (!apiClient) throw new Error('SDK not initialized');
    const dto = await approveNote(apiClient, consultationId, noteId);
    void queryClient.invalidateQueries({ queryKey: clinicalWorkspaceKeys.context(consultationId) });
    void queryClient.invalidateQueries({ queryKey: clinicalWorkspaceKeys.provenance(consultationId, noteId) });
    return dto as unknown as SummaryApprovalResponse;
  };

  const handleSaveEdit = async () => {
    if (!apiClient || !draft.trim()) return;
    setSaving(true);
    try {
      await updateSummaryContent(apiClient, consultationId, noteContextItemId, draft.trim());
      toast.success('Draft updated');
      setEditOpen(false);
      void queryClient.invalidateQueries({ queryKey: clinicalWorkspaceKeys.provenance(consultationId, noteContextItemId) });
      void queryClient.invalidateQueries({ queryKey: clinicalWorkspaceKeys.context(consultationId) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update draft');
    } finally {
      setSaving(false);
    }
  };

  const signed = (data.status ?? '').toUpperCase() === 'SIGNED_NOTE' || (data.status ?? '').toUpperCase() === 'SIGNED';

  return (
    <div className="space-y-3" data-testid="review-panel">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">SOAP review &amp; sign-off</h2>
        {data.status && (
          <Badge variant="outline" className="text-[10px]">
            {data.status}
          </Badge>
        )}
        <Dialog
          open={editOpen}
          onOpenChange={(open) => {
            setEditOpen(open);
            if (open) setDraft(noteContent ?? '');
          }}
        >
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto gap-1.5" disabled={signed} data-testid="review-edit-trigger">
              <Pencil className="size-3.5" />
              Edit draft
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Edit draft note</DialogTitle>
              <DialogDescription>Refine the AI-drafted note before signing. Saved edits create a new draft version.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="review-edit-content">Draft content</Label>
              <Textarea
                id="review-edit-content"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="min-h-64 font-mono text-sm"
                data-testid="review-edit-textarea"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={() => void handleSaveEdit()} disabled={saving || !draft.trim()} data-testid="review-edit-save">
                {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Save draft
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* TASK-344 — the drafted SOAP body is a persisted manual-highlight surface
          (targetKind: 'SUMMARY'). Doctors select-to-highlight key findings; marks
          are saved against the draft note and stay visually distinct from the
          AI-provenance evidence rendered inside the review screen below. */}
      {noteContent && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <h3 className="text-sm font-medium">Highlight key findings</h3>
            <p className="text-muted-foreground -mt-1 text-xs leading-snug">
              Select text in the drafted note to highlight it. Highlights are saved to this consultation and are separate from the AI evidence below.
            </p>
            <ManualHighlightSurface
              consultationId={consultationId}
              targetKind="SUMMARY"
              sourceContextItemId={noteContextItemId}
              text={noteContent}
              data-testid="summary-highlightable"
            />
          </CardContent>
        </Card>
      )}

      <ReviewScreen data={data} onApprove={handleApprove} />
    </div>
  );
}
