'use client';

/**
 * `PublishDialog` — a SHORT confirmation dialog (rule 11 §1: dialogs stay
 * for short confirmations and break-glass step-up, not record detail). Publish is a destructive,
 * effectively-irreversible action (the published row becomes immutable — 1),
 * so it gets an explicit confirm step per rule 11 §5.
 *
 * TASK-890 §3.10 — once the parent reports `published`, the SAME dialog swaps its body for the
 * integration panel: `POST /workflows/{slug}/runs`, the `?mode=` set the definition actually
 * admits, a copyable `@arcaai/vox-node` snippet, and a link to `/api-keys`. This is the moment a
 * tenant admin needs that information — right after the thing they just made became reachable.
 *
 * TASK-965 — the panel itself is the console-shared `IntegrationPanel` (`@/shared/versioning`),
 * which the studio ALSO shows from its header for any published version, so the dialog is no
 * longer the only place the endpoint can be seen. The three non-error outcomes (published without
 * activation; a palette that is not exposable; the tenant's exposure gate off) are explained
 * there on their own terms.
 */
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, FieldContent, FieldDescription, FieldLabel, Switch } from '@arcaai/ui';
import { useState } from 'react';
import { IntegrationPanel } from '@/shared/versioning';

export interface PublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (activate: boolean) => void;
  confirming?: boolean;
  /** TASK-890 §3.10 — once true, the dialog shows the integration panel instead of the confirm step. */
  published?: boolean;
  /** The definition's slug — required to resolve `GET workflows/{slug}/schema` once published. */
  slug?: string;
  /** TASK-965 — whether the publish ACTIVATED this version (the response's `isActive`). Default `true`. */
  activated?: boolean;
  /** TASK-965 — whether the definition's palette is exposable on the public invoke surface. Default `true`. */
  exposable?: boolean;
  /** The palette named in the not-exposable explanation. */
  paletteKey?: string;
}

export function PublishDialog({ open, onOpenChange, onConfirm, confirming, published, slug, activated = true, exposable = true, paletteKey }: PublishDialogProps) {
  const [activate, setActivate] = useState(true);

  if (published && slug) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Published</DialogTitle>
            <DialogDescription>{activated ? 'This version is live. Here is how your developers reach it.' : 'This version is frozen and can be activated later.'}</DialogDescription>
          </DialogHeader>
          <IntegrationPanel kind="workflow" slug={slug} isActive={activated} exposable={exposable} paletteKey={paletteKey} />
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish this version?</DialogTitle>
          <DialogDescription>
            Publishing compiles the graph and freezes this version — it can no longer be edited. Further changes create a new version.
          </DialogDescription>
        </DialogHeader>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="publish-activate">Make this the active version</FieldLabel>
            <FieldDescription>New runs resolve this version immediately, demoting the current active version.</FieldDescription>
          </FieldContent>
          <Switch id="publish-activate" checked={activate} onCheckedChange={setActivate} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={confirming}>
            Cancel
          </Button>
          <Button type="button" onClick={() => onConfirm(activate)} disabled={confirming}>
            {confirming ? 'Publishing…' : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
