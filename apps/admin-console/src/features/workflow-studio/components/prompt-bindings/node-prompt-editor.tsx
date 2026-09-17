'use client';

/**
 * DD-11's in-node prompt edit, as a dialog.
 *
 * It opens on the template's LATEST version content, which is the whole design:
 * an admin told "this node is behind" needs to SEE what they would be adopting
 * before adopting it.
 *
 * Since item 1, saving that content UNCHANGED is an ADOPTION: the server
 * moves this node's pin to the existing latest version and mints nothing (and
 * writes nothing at all if the node is already pinned there). Editing it first
 * is an AUTHORING act and still mints. Because DD-11 PATH 2 deliberately leaves
 * node pins alone when a template is edited out of band, adoption is the COMMON
 * path through this dialog — so the action label tracks which one saving would
 * perform, and the success message reports which one the SERVER actually
 * performed (`promptVersionMinted` / `promptVersionNumber` off the response),
 * never `latest + 1`. A toast that claims an immutable clinical artifact was
 * created when none was is the kind of lie that survives review because it
 * looks harmless.
 *
 * The label is a prediction from the content in the box; the toast is the fact.
 * They can only disagree if the server's checksum sees something the editor
 * cannot (it also hashes the template's `variables`, which this dialog does not
 * edit) — and in that case the toast, not the label, is what the admin is left
 * holding.
 *
 * A dialog, not a `DetailDrawer`: this is a single focused decision on one
 * field, not a record with tabs (rule 11 §1 — `DetailDrawer` owns RECORD
 * detail; dialogs stay for short, self-contained actions).
 */

import { useId, useState } from 'react';
import { IconAlertTriangle } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { usePromptTemplateVersions, useUpdateNodePrompt } from '../../api';
import type { NodePromptBinding, NodePromptUpdateResult } from '../../api/types';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';

function latestContent(versions: { versionNumber: number; content: string }[]): string {
  if (versions.length === 0) return '';
  return [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0].content;
}

/**
 * What the server did, in the server's own words — three outcomes, never conflated.
 *
 * `promptVersionMinted` is the only thing that can distinguish "a new immutable version now
 * exists" from "an existing one was adopted", and `previousPromptVersionNumber === promptVersionNumber`
 * is the only thing that distinguishes an adoption that moved a pin from one that changed
 * nothing whatsoever.
 */
function outcomeMessage(nodeId: string, result: NodePromptUpdateResult): string {
  if (result.promptVersionMinted) return `Minted v${result.promptVersionNumber} and pinned ${nodeId} to it`;
  if (result.previousPromptVersionNumber === result.promptVersionNumber) {
    return `${nodeId} was already pinned to v${result.promptVersionNumber} — nothing changed`;
  }
  return `Pinned ${nodeId} to the existing v${result.promptVersionNumber} — no new version was created`;
}

export function NodePromptEditor({
  binding,
  definitionId,
  etag,
  open,
  onOpenChange,
  onSaved,
}: {
  binding: NodePromptBinding | null;
  definitionId: string;
  etag: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const uid = useId();
  const versionsQuery = usePromptTemplateVersions(open && binding ? binding.promptTemplateId : null);
  const updatePrompt = useUpdateNodePrompt();
  const [content, setContent] = useState<string | null>(null);
  const [changeReason, setChangeReason] = useState('');

  // Seed the editor from the template's latest version once per open, adjusted
  // during render rather than in an effect so it cannot fire twice for one load
  // and cannot clobber an in-progress edit on a background refetch.
  const versions = versionsQuery.data ?? [];
  const seedKey = open && binding && versionsQuery.isSuccess ? `${binding.nodeId}:${binding.promptTemplateId}` : null;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seedKey && seedKey !== seededFor) {
    setSeededFor(seedKey);
    setContent(latestContent(versions));
  }

  const latestVersionNumber = binding?.latestVersionNumber ?? null;
  const nextVersionNumber = (latestVersionNumber ?? 0) + 1;
  // Which branch saving WOULD take, from the content in the box. `content === null` means the
  // template's versions have not loaded yet, so there is nothing to compare and nothing to save.
  const wouldAdopt = latestVersionNumber != null && content !== null && content === latestContent(versions);

  function handleSave() {
    if (!binding || !etag || content === null) return;
    updatePrompt.mutate(
      { definitionId, nodeId: binding.nodeId, body: { content, changeReason: changeReason.trim() || undefined }, etag },
      {
        onSuccess: ({ data }) => {
          toast.success(outcomeMessage(binding.nodeId, data));
          setChangeReason('');
          setSeededFor(null);
          onSaved();
          onOpenChange(false);
        },
        onError: (error) => {
          toast.error(error instanceof GatewayError ? error.message : 'Could not update this node’s prompt.');
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG_SIZE_CLASS.lg}>
        <DialogHeader>
          <DialogTitle>Edit prompt for {binding?.nodeId ?? 'node'}</DialogTitle>
          <DialogDescription>
            This edits the prompt of “{binding?.promptTemplateName ?? binding?.promptTemplateId}” for THIS node only — other nodes using the same
            template are never moved.
            {latestVersionNumber != null
              ? ` Saving unchanged content adopts v${latestVersionNumber} and creates nothing; any edit mints v${nextVersionNumber} and pins this node to it.`
              : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {binding?.hasNewVersion ? (
            <Alert>
              <IconAlertTriangle aria-hidden />
              <AlertTitle>
                This node is pinned to v{binding.pinnedVersionNumber}; the template is on v{binding.latestVersionNumber}
              </AlertTitle>
              <AlertDescription>
                The editor below is showing v{binding.latestVersionNumber} — the current template text. Review it and save to adopt that version as
                it stands, or edit it first to mint v{nextVersionNumber} instead.
              </AlertDescription>
            </Alert>
          ) : null}

          {versionsQuery.isPending ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2" aria-hidden>
              <Skeleton className="h-4 w-40" />
              <Skeleton className="min-h-0 flex-1" />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <Label htmlFor={`${uid}-content`}>Prompt content</Label>
              {/* A `Textarea`, not `CodeEditor`: a prompt is prose, and
                  `CodeEditor` is JSON-only — it would run JSON parse validation
                  and flag every real prompt as invalid. Same control the
                  authoritative editor on /prompt-templates uses. */}
              <Textarea
                id={`${uid}-content`}
                aria-label="Prompt content"
                value={content ?? ''}
                onChange={(event) => setContent(event.target.value)}
                className="min-h-40 flex-1 resize-none font-mono text-xs"
              />
            </div>
          )}

          <div className="flex shrink-0 flex-col gap-2">
            <Label htmlFor={`${uid}-reason`}>Change reason (optional)</Label>
            <Input
              id={`${uid}-reason`}
              value={changeReason}
              onChange={(event) => setChangeReason(event.target.value)}
              placeholder="Adopt the reviewed wording from the prompt library"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={updatePrompt.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={!etag || content === null || updatePrompt.isPending}>
            {updatePrompt.isPending ? <Spinner /> : null}
            {wouldAdopt ? `Adopt v${latestVersionNumber} for this node` : `Save as v${nextVersionNumber} and pin this node`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
