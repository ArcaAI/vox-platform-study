'use client';

/**
 * DD-11's in-node prompt edit, as a dialog.
 *
 * It opens on the template's LATEST version content, which is the whole design:
 * an admin told "this node is behind" needs to SEE what they would be adopting
 * before adopting it. Saving unchanged content adopts it as-is; editing first
 * adopts an edited variant. Either way the server mints a new immutable
 * `PromptVersion` and moves THIS node's pin to it in one transaction — so the
 * dialog says that plainly rather than offering a bare "update" that hides
 * which of the two DD-11 paths is being taken.
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
import type { NodePromptBinding } from '../../api/types';

function latestContent(versions: { versionNumber: number; content: string }[]): string {
  if (versions.length === 0) return '';
  return [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0].content;
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

  const nextVersionNumber = (binding?.latestVersionNumber ?? 0) + 1;

  function handleSave() {
    if (!binding || !etag || content === null) return;
    updatePrompt.mutate(
      { definitionId, nodeId: binding.nodeId, body: { content, changeReason: changeReason.trim() || undefined }, etag },
      {
        onSuccess: () => {
          toast.success(`Minted v${nextVersionNumber} and pinned ${binding.nodeId} to it`);
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
      <DialogContent className="flex h-[70vh] flex-col sm:max-w-[70vw]">
        <DialogHeader>
          <DialogTitle>Edit prompt for {binding?.nodeId ?? 'node'}</DialogTitle>
          <DialogDescription>
            Saving mints a new immutable version of “{binding?.promptTemplateName ?? binding?.promptTemplateId}” and pins THIS node to it, in one
            transaction. Other nodes using the same template are not moved.
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
                The editor below is showing v{binding.latestVersionNumber} — the current template text. Review it, edit if you need to, then save to
                adopt it as v{nextVersionNumber} for this node.
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
            Save as v{nextVersionNumber} and pin this node
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
