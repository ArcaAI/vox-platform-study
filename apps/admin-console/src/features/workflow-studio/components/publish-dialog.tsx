'use client';

/**
 * `PublishDialog` — a SHORT confirmation dialog (rule 11 §1: dialogs stay
 * for short confirmations and break-glass step-up, not record detail). Publish is a destructive,
 * effectively-irreversible action (the published row becomes immutable — 1),
 * so it gets an explicit confirm step per rule 11 §5.
 *
 * TASK-890 §3.10 — once the parent reports `published`, the SAME dialog swaps its body for the
 * resolved endpoints panel: `POST /workflows/{slug}/runs`, the `?mode=` set the definition
 * actually admits (read from `GET workflows/{slug}/schema` — `WorkflowRunSchema`, `socket`
 * filtered out because it is a delivery LANE, never a `?mode=` query value, `modesFor`'s own
 * doc), a copyable `@arcaai/vox-node` snippet, and a link to `/api-keys` to mint a key that can
 * actually reach it. This is the moment a tenant admin needs that information — right after the
 * thing they just made became reachable — so it rides the SAME dialog rather than a second one.
 */
import Link from 'next/link';
import { IconAlertTriangle, IconExternalLink } from '@tabler/icons-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  Skeleton,
  Switch,
} from '@arcaai/ui';
import { useState } from 'react';
import { CopyButton } from '@/shared/copy-button';
import { workflowVoxNodeSnippet } from '@/shared/docs/sdk-snippets';
import { useWorkflowSchema } from '../api/hooks';

const API_KEYS_HREF = '/api-keys';
const SOCKET_MODE = 'socket';

export interface PublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (activate: boolean) => void;
  confirming?: boolean;
  /** TASK-890 §3.10 — once true, the dialog shows the resolved endpoints panel instead of the confirm step. */
  published?: boolean;
  /** The definition's slug — required to fetch `GET workflows/{slug}/schema` once published. */
  slug?: string;
}

function EndpointsPanel({ slug }: { slug: string }) {
  const schema = useWorkflowSchema(slug, true);

  if (schema.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (schema.isError) {
    return (
      <Alert variant="destructive">
        <IconAlertTriangle aria-hidden />
        <AlertTitle>Couldn&apos;t resolve this workflow&apos;s endpoints</AlertTitle>
        <AlertDescription>The definition published, but its run contract could not be read back. Reopen this dialog to retry.</AlertDescription>
      </Alert>
    );
  }

  const runPath = `POST /workflows/${slug}/runs`;
  const modes = (schema.data?.modes ?? []).filter((mode) => mode !== SOCKET_MODE);
  const snippet = workflowVoxNodeSnippet(slug);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <code className="bg-muted rounded-md border px-2 py-1 font-mono text-xs">{runPath}</code>
        <CopyButton value={runPath} label="Copy the run endpoint" />
      </div>
      {modes.length > 0 ? (
        <div>
          <FieldDescription>Accepted <code className="font-mono">?mode=</code> values</FieldDescription>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {modes.map((mode) => (
              <Badge key={mode} variant="outline" className="font-mono">
                {mode}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      <div>
        <FieldDescription>Invoke it from a backend with @arcaai/vox-node</FieldDescription>
        <div className="group/code relative mt-1" role="group" aria-label="Node.js (@arcaai/vox-node) snippet">
          <pre className="bg-muted text-foreground overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
            <code>{snippet}</code>
          </pre>
          <div className="absolute top-2 right-2">
            <CopyButton value={snippet} label="Copy the vox-node snippet" />
          </div>
        </div>
      </div>
      <Link href={API_KEYS_HREF} className="text-foreground inline-flex w-fit items-center gap-1 text-sm hover:underline">
        <IconExternalLink aria-hidden className="size-3.5" />
        Mint an API key to call it (API Keys)
      </Link>
    </div>
  );
}

export function PublishDialog({ open, onOpenChange, onConfirm, confirming, published, slug }: PublishDialogProps) {
  const [activate, setActivate] = useState(true);

  if (published && slug) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Published</DialogTitle>
            <DialogDescription>This version is live. Here is how your developers reach it.</DialogDescription>
          </DialogHeader>
          <EndpointsPanel slug={slug} />
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
