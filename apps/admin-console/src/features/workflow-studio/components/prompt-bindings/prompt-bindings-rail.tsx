'use client';

/**
 * DD-11's "new version available" affordance — the visible half of the
 * two-path prompt-versioning design.
 *
 * The design deliberately has two update paths with DIFFERENT semantics:
 * editing a prompt from within a node mints a version and moves that node's pin
 * immediately; editing the same template from the Prompt-management screen
 * mints a version and moves NO node's pin. The second is what stops one shared
 * template silently re-prompting every workflow that references it. But its
 * cost is that a node can sit on v4 while the template is on v5 with nothing
 * anywhere saying so — and a guarantee nobody can see is indistinguishable from
 * "nothing ever updates".
 *
 * So this rail lives beside the inspector, in the editor an admin already has
 * open, and reports three states per node — never two:
 *
 *   pinned + behind    "New v5 available" + the action to adopt it
 *   pinned + current   the pin, quietly
 *   unpinned           "Follows template" — NOT flagged as behind
 *
 * That third state matters. An unpinned node deliberately tracks the template;
 * reporting it as stale would put a permanent badge on a correct configuration
 * and train admins to ignore the signal that does mean something.
 */

import { useState } from 'react';
import Link from 'next/link';
import { IconArrowUpCircle, IconPencil, IconVersions } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useNodePromptBindings } from '../../api';
import type { NodePromptBinding } from '../../api/types';
import { NodePromptEditor } from './node-prompt-editor';

function BindingRow({
  binding,
  readOnly,
  onFocusNode,
  onEdit,
}: {
  binding: NodePromptBinding;
  readOnly: boolean;
  onFocusNode?: (nodeId: string) => void;
  onEdit: (binding: NodePromptBinding) => void;
}) {
  const pinLabel =
    binding.pinnedVersionNumber != null ? `Pinned to v${binding.pinnedVersionNumber}` : 'Follows template — no pin';

  // The node-id button's hover affordance is the UNDERLINE, deliberately. Under
  // the achromatic identity the brand ink token resolves to body ink, so a hover
  // colour swap would compile, read like a signal, and render nothing — the
  // collapse `emphasis-canon.test.ts` exists to catch. Emphasis here comes from
  // the underline and the monospace weight, both of which are actually visible.
  return (
    <li>
      <Card className="flex-col items-stretch gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {onFocusNode ? (
            <button
              type="button"
              onClick={() => onFocusNode(binding.nodeId)}
              className="cursor-pointer truncate font-mono text-sm font-medium underline-offset-2 hover:underline"
            >
              {binding.nodeId}
            </button>
          ) : (
            <span className="truncate font-mono text-sm font-medium">{binding.nodeId}</span>
          )}
          {/* Never colour alone — the badge carries its own text (rule 11 §11). */}
          {binding.hasNewVersion ? <Badge variant="secondary">New v{binding.latestVersionNumber} available</Badge> : null}
        </div>

        <div className="text-muted-foreground flex flex-col gap-0.5 text-xs">
          <span className="truncate">{binding.promptTemplateName ?? binding.promptTemplateId}</span>
          <span className="font-mono">
            {pinLabel}
            {binding.latestVersionNumber != null ? ` · template at v${binding.latestVersionNumber}` : ''}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant={binding.hasNewVersion ? 'default' : 'outline'} disabled={readOnly} onClick={() => onEdit(binding)}>
            {binding.hasNewVersion ? <IconArrowUpCircle aria-hidden /> : <IconPencil aria-hidden />}
            {binding.hasNewVersion ? `Review and adopt v${binding.latestVersionNumber}` : 'Edit prompt for this node'}
          </Button>
          {/* Plain href, never a cross-feature import: `/prompt-templates` is the
              authoritative editor for the template itself (rule 13 §Routing). */}
          <Link href="/prompt-templates" className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2">
            Manage prompt templates
          </Link>
        </div>
      </Card>
    </li>
  );
}

export function PromptBindingsRail({
  definitionId,
  etag,
  readOnly = false,
  onFocusNode,
}: {
  definitionId: string;
  etag: string | null;
  readOnly?: boolean;
  onFocusNode?: (nodeId: string) => void;
}) {
  const bindingsQuery = useNodePromptBindings(definitionId);
  const [editing, setEditing] = useState<NodePromptBinding | null>(null);

  const bindings = bindingsQuery.data ?? [];
  const behind = bindings.filter((binding) => binding.hasNewVersion).length;

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`prompt-bindings-${definitionId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`prompt-bindings-${definitionId}`} className="text-sm font-medium">
          Prompt bindings ({bindings.length})
        </h2>
        {behind > 0 ? (
          <Badge variant="secondary">
            {behind} behind {behind === 1 ? 'its template' : 'their templates'}
          </Badge>
        ) : null}
      </div>

      {bindingsQuery.isPending ? (
        <div className="flex flex-col gap-2" aria-hidden>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : bindingsQuery.error ? (
        <ErrorState error={bindingsQuery.error} onRetry={() => void bindingsQuery.refetch()} />
      ) : bindings.length === 0 ? (
        <EmptyState
          icon={IconVersions}
          title="No prompt bindings"
          description="No node in this graph references a prompt template yet. A text-generation node must reference one before it can be pinned to a version."
        />
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            Editing a prompt HERE mints a new version and re-pins that node immediately. Editing the same template on the Prompt Templates screen mints a
            version and moves no node’s pin — which is why a node can fall behind, and why this list exists.
          </p>
          <ul className="flex flex-col gap-2">
            {bindings.map((binding) => (
              <BindingRow key={binding.nodeId} binding={binding} readOnly={readOnly} onFocusNode={onFocusNode} onEdit={setEditing} />
            ))}
          </ul>
        </>
      )}

      <NodePromptEditor
        binding={editing}
        definitionId={definitionId}
        etag={etag}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={() => void bindingsQuery.refetch()}
      />
    </section>
  );
}
