'use client';

/**
 * TASK-890 §3.8/§3.9/§3.10 — the agent publish dialog. Confirms the same short "activate"
 * decision `PublishDialog` (workflow-studio) does — publish freezes the version, so it is an
 * effectively-irreversible action per rule 11 §5 — and, once published, hands the developer what
 * they need to integrate: the resolved endpoint (task-shaped), a copyable `@arcaai/vox-node`
 * snippet, and a link to mint an API key. Features never import each other (rule 13), so this is
 * its own small copy of the confirm shape rather than an import of the Studio's.
 */
import { useState } from 'react';
import Link from 'next/link';
import { IconExternalLink } from '@tabler/icons-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, FieldContent, FieldDescription, FieldLabel, Switch } from '@arcaai/ui';
import { agentVoxNodeSnippet, type SdkSnippetAgentTask } from '@/shared/docs/sdk-snippets';
import type { Agent, AgentTask } from '../api';

interface EndpointDescriptor {
  method: 'POST';
  path: string;
  note?: string;
}

const ENDPOINTS: Record<AgentTask, EndpointDescriptor> = {
  TEXT_GENERATION: { method: 'POST', path: '/agents/{slug}/invocations', note: '?mode=blocking (default) or ?mode=stream for SSE' },
  SPEECH_TO_TEXT: { method: 'POST', path: '/agents/{slug}/transcriptions' },
  TEXT_TO_SPEECH: { method: 'POST', path: '/agents/{slug}/speech' },
  // TASK-930 — the SAME route as text generation, and deliberately without the `?mode=stream`
  // note: token classification is one-shot, and `mode=stream` on it is a 400, not a slower answer.
  NAMED_ENTITY_RECOGNITION: { method: 'POST', path: '/agents/{slug}/invocations' },
};


export interface AgentPublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (activate: boolean) => void;
  confirming?: boolean;
  /** The DRAFT/VALIDATED row about to be published. */
  agent: Agent;
  /** Set once the publish call has succeeded — switches the dialog to the integration view. */
  published: Agent | null;
}

/**
 * TASK-930 — which SNIPPET shape a task takes.
 *
 * NER shares `hope.agents.invoke(slug, { text })` with text generation: same route, same call,
 * only the `output` differs (`{ entities }` rather than `{ text }`), so the invoke-shaped
 * snippet is correct for it rather than merely tolerable. Mapped HERE instead of widening
 * `SdkSnippetAgentTask` because `shared/docs/` serves every feature and a NER-specific example
 * — one that shows the entity payload — is a change to the shared snippet vocabulary, not to
 * this dialog.
 */
function snippetTaskOf(task: AgentTask): SdkSnippetAgentTask {
  return task === 'NAMED_ENTITY_RECOGNITION' ? 'TEXT_GENERATION' : task;
}

export function AgentPublishDialog({ open, onOpenChange, onConfirm, confirming, agent, published }: AgentPublishDialogProps) {
  const [activate, setActivate] = useState(true);

  if (published) {
    const endpoint = ENDPOINTS[published.task];
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{published.name} is published</DialogTitle>
            <DialogDescription>Reach it from either SDK on an API key holding the business-plane scopes — never the admin plane.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div>
              <h4 className="text-sm font-medium">Endpoint</h4>
              <p className="font-mono text-xs">
                {endpoint.method} {endpoint.path.replace('{slug}', published.slug)}
              </p>
              {endpoint.note ? <p className="text-muted-foreground text-xs">{endpoint.note}</p> : null}
            </div>
            <div>
              <h4 className="text-sm font-medium">@arcaai/vox-node</h4>
              <pre className="bg-muted overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{agentVoxNodeSnippet(published.slug, snippetTaskOf(published.task))}</pre>
            </div>
            <Link href="/api-keys" className="inline-flex items-center gap-1 text-sm underline underline-offset-2">
              Mint an API key <IconExternalLink aria-hidden className="size-3" />
            </Link>
          </div>
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
          <DialogTitle>Publish {agent.name}?</DialogTitle>
          <DialogDescription>Publishing compiles and freezes this version — it can no longer be edited. Further changes create a new version.</DialogDescription>
        </DialogHeader>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="agent-publish-activate">Make this the active version</FieldLabel>
            <FieldDescription>New invocations resolve this version immediately, demoting the current active version.</FieldDescription>
          </FieldContent>
          <Switch id="agent-publish-activate" checked={activate} onCheckedChange={setActivate} />
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
