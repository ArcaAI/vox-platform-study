/**
 * ContextPanel (TASK-330 P3, WS4 mid-visit context).
 *
 * Adds Case notes (CASE_NOTE), Work notes (WORKNOTE) and Lab/exam results
 * (file → ATTACHMENT with `metadata.subType = 'LAB_RESULT'`) to the live
 * consultation, and shows a running list of what's been added. Writes go through
 * `POST /consultations/:id/context` (+ storage upload for files); the list is a
 * React Query read that's invalidated after each add.
 */
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent } from '@arcaai/ui/card';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Textarea } from '@arcaai/ui/textarea';
import { useArcaStore, useStorage, type AgenticClient } from '@arcaai/vox';
import { useQueryClient } from '@tanstack/react-query';
import { FileText, FlaskConical, Loader2, Paperclip, StickyNote, Trash2, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { addContextItem, deleteContextItem } from '../api/clinical-workspace.api';
import { clinicalWorkspaceKeys, useContextItemsQuery } from '../api/queries';
import { LAB_RESULT_SUBTYPE, STORAGE_BUCKET } from '../constants';
import { extractTextFromFile } from '../lib/extract-text';
import type { HighlightTargetKind, WorkspaceContextType } from '../types';
import { ManualHighlightSurface } from './highlightable-surface';

interface ContextPanelProps {
  consultationId: string;
}

const TYPE_LABEL: Record<string, string> = {
  CASE_NOTE: 'Case note',
  WORKNOTE: 'Work note',
  TRANSCRIPT: 'Transcript',
  ATTACHMENT: 'Attachment',
  AUDIO_RECORDING: 'Audio',
  RAW_SUMMARY: 'Draft summary',
  MODIFIED_SUMMARY: 'Edited summary',
  SIGNED_NOTE: 'Signed note',
};

/**
 * TASK-344 Workstream B — which persisted note types support manual doctor
 * highlighting (text surfaces only; attachments/audio carry no anchorable text).
 */
function highlightTargetForType(type: WorkspaceContextType): HighlightTargetKind | null {
  switch (type) {
    case 'CASE_NOTE':
      return 'CASE_NOTE';
    case 'WORKNOTE':
      return 'WORKNOTE';
    case 'TRANSCRIPT':
      return 'TRANSCRIPT';
    case 'RAW_SUMMARY':
    case 'MODIFIED_SUMMARY':
    case 'SIGNED_NOTE':
      return 'SUMMARY';
    default:
      return null;
  }
}

export function ContextPanel({ consultationId }: ContextPanelProps) {
  const apiClient = useArcaStore((s: { apiClient: AgenticClient | null }) => s.apiClient);
  const storage = useStorage();
  const queryClient = useQueryClient();
  const contextQuery = useContextItemsQuery(consultationId);

  const [caseNote, setCaseNote] = useState('');
  const [workNote, setWorkNote] = useState('');
  const [labFile, setLabFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const labInputRef = useRef<HTMLInputElement>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: clinicalWorkspaceKeys.context(consultationId) });

  const addNote = async (type: WorkspaceContextType, content: string, reset: () => void, successMsg: string) => {
    if (!apiClient || !content.trim()) return;
    setSubmitting(true);
    try {
      await addContextItem(apiClient, consultationId, { type, content: content.trim() });
      toast.success(successMsg);
      reset();
      void invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add context');
    } finally {
      setSubmitting(false);
    }
  };

  const addLabResult = async () => {
    if (!apiClient || !labFile) return;
    setSubmitting(true);
    try {
      // TASK-656 — mediaId is a Media table row UUID (resolved server-side via
      // MediaRepository), NOT the raw storage key; sending `key` here meant
      // every downstream mediaId lookup (presigned URLs, OCR, ...) silently
      // found nothing.
      const { mediaId } = await storage.uploadFile(STORAGE_BUCKET, labFile);
      // TASK-342 GAP #5 — extract trivially-readable file text (txt / csv / md /
      // json) in-browser so the CONTENTS, not just the filename, reach the live
      // summary + harness assemble. Binary / scanned files yield no text and fall
      // back to the filename label (heavy OCR is a deferred follow-up).
      const extractedText = await extractTextFromFile(labFile);
      await addContextItem(apiClient, consultationId, {
        type: 'ATTACHMENT',
        content: `Lab/exam result: ${labFile.name}`,
        mediaId,
        metadata: { subType: LAB_RESULT_SUBTYPE, fileName: labFile.name, ...(extractedText ? { extractedText } : {}) },
      });
      toast.success('Lab/exam result added');
      setLabFile(null);
      if (labInputRef.current) labInputRef.current.value = '';
      void invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add lab result');
    } finally {
      setSubmitting(false);
    }
  };

  const removeItem = async (id: string) => {
    if (!apiClient) return;
    setRemovingId(id);
    try {
      await deleteContextItem(apiClient, consultationId, id);
      toast.success('Context removed');
      void invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove context');
    } finally {
      setRemovingId(null);
    }
  };

  const items = contextQuery.data ?? [];

  return (
    <Card className="flex h-full flex-col">
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <FileText className="text-muted-foreground size-4" />
          <h3 className="text-sm font-medium">Mid-visit context</h3>
        </div>
        {/* TASK-342 GAP #4 — make the mid-visit influence model explicit: case &
            work notes propagate into the LIVE summary as they're added; to edit the
            summary text directly, finalize (Stop) and edit the draft in Review. */}
        <p className="text-muted-foreground -mt-1 text-xs leading-snug" data-testid="mid-visit-influence-hint">
          Case &amp; work notes flow into the live summary as you add them. To edit the note text directly, finalize (Stop) and edit the draft in
          Review.
        </p>

        <Tabs defaultValue="case-note">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="case-note" className="gap-1.5 text-xs">
              <FileText className="size-3.5" />
              Case note
            </TabsTrigger>
            <TabsTrigger value="work-note" className="gap-1.5 text-xs">
              <StickyNote className="size-3.5" />
              Work note
            </TabsTrigger>
            <TabsTrigger value="lab" className="gap-1.5 text-xs">
              <FlaskConical className="size-3.5" />
              Lab / exam
            </TabsTrigger>
          </TabsList>

          <TabsContent value="case-note" className="mt-3 space-y-2">
            <Textarea
              value={caseNote}
              onChange={(e) => setCaseNote(e.target.value)}
              placeholder="Clinical observation or patient history…"
              className="min-h-20 resize-none"
              data-testid="case-note-input"
            />
            <Button
              size="sm"
              disabled={submitting || !caseNote.trim()}
              onClick={() => void addNote('CASE_NOTE', caseNote, () => setCaseNote(''), 'Case note added')}
            >
              {submitting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Add case note
            </Button>
          </TabsContent>

          <TabsContent value="work-note" className="mt-3 space-y-2">
            <Textarea
              value={workNote}
              onChange={(e) => setWorkNote(e.target.value)}
              placeholder="Internal work note (not patient-facing)…"
              className="min-h-20 resize-none"
              data-testid="work-note-input"
            />
            <Button
              size="sm"
              disabled={submitting || !workNote.trim()}
              onClick={() => void addNote('WORKNOTE', workNote, () => setWorkNote(''), 'Work note added')}
            >
              {submitting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Add work note
            </Button>
          </TabsContent>

          <TabsContent value="lab" className="mt-3 space-y-2">
            <Label htmlFor="lab-file" className="text-xs">
              Lab / exam result file
            </Label>
            <Input ref={labInputRef} id="lab-file" type="file" onChange={(e) => setLabFile(e.target.files?.[0] ?? null)} />
            {labFile && (
              <div className="flex items-center gap-2 rounded-md border p-2 text-sm">
                <Paperclip className="text-muted-foreground size-3.5" />
                <span className="flex-1 truncate">{labFile.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-6 p-0"
                  onClick={() => {
                    setLabFile(null);
                    if (labInputRef.current) labInputRef.current.value = '';
                  }}
                >
                  <X className="size-3" />
                </Button>
              </div>
            )}
            <Button size="sm" disabled={submitting || !labFile} onClick={() => void addLabResult()}>
              {submitting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Upload className="mr-1.5 size-4" />}
              Upload lab/exam result
            </Button>
          </TabsContent>
        </Tabs>

        <div className="min-h-0 flex-1 border-t pt-2">
          <p className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">Added context</p>
          <ScrollArea className="h-full">
            {contextQuery.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : items.length === 0 ? (
              <p className="text-muted-foreground text-sm">No context added yet. Add a case note, work note, or lab/exam result above.</p>
            ) : (
              <ul className="space-y-1.5 pr-2" data-testid="context-list">
                {items.map((it) => {
                  // TASK-344 Workstream B — persisted text notes become highlightable
                  // surfaces (select-to-highlight + remove); attachments/audio stay
                  // as a compact truncated row.
                  const highlightTarget = highlightTargetForType(it.type);
                  return (
                    <li key={it.id} className="rounded-md border p-2 text-sm">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          {TYPE_LABEL[it.type] ?? it.type}
                        </Badge>
                        {!highlightTarget && <span className="flex-1 truncate">{it.content}</span>}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="ml-auto size-6 shrink-0 p-0"
                          aria-label="Remove context"
                          data-testid={`remove-context-${it.id}`}
                          disabled={removingId === it.id}
                          onClick={() => void removeItem(it.id)}
                        >
                          {removingId === it.id ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                        </Button>
                      </div>
                      {highlightTarget && (
                        <ManualHighlightSurface
                          consultationId={consultationId}
                          targetKind={highlightTarget}
                          sourceContextItemId={it.id}
                          text={it.content}
                          className="mt-1.5"
                          data-testid={`highlightable-${it.id}`}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        </div>
      </CardContent>
    </Card>
  );
}
