'use client';

/**
 * TASK-890 §3.8/§3.9/§3.10 — the agent publish dialog. Confirms the same short "activate"
 * decision `PublishDialog` (workflow-studio) does — publish freezes the version, so it is an
 * effectively-irreversible action per rule 11 §5 — and, once published, hands the developer what
 * they need to integrate. Features never import each other (rule 13), so this is its own small
 * copy of the confirm shape rather than an import of the Studio's.
 *
 * TASK-965 — the integration view is the console-shared `IntegrationPanel` (`@/shared/versioning`),
 * which the drawer's Integration tab ALSO renders for every published version, so this dialog is
 * no longer the only place the endpoint and snippet can be seen.
 */
import { useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, FieldContent, FieldDescription, FieldLabel, Switch } from '@arcaai/ui';
import { IntegrationPanel } from '@/shared/versioning';
import type { Agent } from '../api';

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

export function AgentPublishDialog({ open, onOpenChange, onConfirm, confirming, agent, published }: AgentPublishDialogProps) {
  const [activate, setActivate] = useState(true);
  // TASK-965 WS-1 (AG-6) — the switch is a per-open decision, never remembered across opens: the
  // component stays mounted for the drawer's lifetime, so a single "off" used to make every later
  // publish default to inactive. Adjusted during render on the open transition (the compiler lint
  // forbids `setState` inside an effect body).
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) setActivate(true);
  }

  if (published) {
    return (
      // TASK-971 lane C — the published step now hosts a four-tab panel, so it takes rule 11 §3's
      // "Large dialog (multi-tab, editor)" shape: a fixed 70vh/70vw flex column whose BODY is the
      // only thing that scrolls. The confirm step below stays a short dialog, because it still is
      // one.
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex h-[70vh] flex-col sm:max-w-[70vw]">
          <DialogHeader className="shrink-0">
            <DialogTitle>{published.name} is published</DialogTitle>
            <DialogDescription>
              {published.isActive ? 'This version is active. Here is how your developers reach it.' : 'This version is frozen and can be activated later.'}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <IntegrationPanel
              kind="agent"
              slug={published.slug}
              task={published.task}
              versionNumber={published.versionNumber}
              isActive={published.isActive}
              inputSchema={published.inputSchema}
              /* TASK-971 FU-1 — the instruction's `trigger.*` bindings, which `inputSchema` never
                 declares and the invocation still requires. TASK-991 wave 2: it also carries the
                 publish-stamped `requiredVariables`, which is where the panel reads the prompt
                 placeholders from — so this one prop covers both. */
              compiledConfig={published.compiledConfig}
            />
          </div>
          <DialogFooter className="shrink-0">
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
