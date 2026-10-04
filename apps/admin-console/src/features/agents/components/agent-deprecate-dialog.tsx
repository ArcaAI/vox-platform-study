'use client';

/**
 * TASK-1036 OD-21 — the agent flavour of the shared deprecate confirmation.
 *
 * `DeprecateVersionDialog` (`@/shared/versioning`) states what deprecation does to the SLUG's
 * assignments. For an agent there is a second reader it cannot know about: a PUBLISHED workflow
 * pins `agentRef.versionNumber` (W3), and a pinned version keeps running after it is deprecated.
 * That is deliberate — retiring a version must not break a published workflow — but the author
 * should know before retiring something in use.
 *
 * No route answers "which published workflows pin v N" without reading every graph, so the
 * warning is stated without a count rather than guessed at.
 */
import type { ReactNode } from 'react';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import type { AssignmentSummary } from '@/shared/versioning';

export interface AgentDeprecateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemLabel: string;
  slug: string;
  versionNumber: number;
  /** Whether the version being retired is the one currently serving. */
  isActive?: boolean;
  assignment?: AssignmentSummary;
  isPending?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function AgentDeprecateDialog({ open, onOpenChange, itemLabel, slug, versionNumber, isActive = false, assignment, isPending, onConfirm }: AgentDeprecateDialogProps) {
  const departments = assignment?.departmentCount ?? 0;
  const consequences: ReactNode[] = [
    `Any published workflow that pins v${versionNumber} of “${itemLabel}” will keep running v${versionNumber} after it is deprecated. Check Workflow Studio for workflows that use it before you retire it; deprecation only stops new pins and activation.`,
    ...(isActive
      ? [
          `v${versionNumber} is the active version, so “${itemLabel}” will stop resolving until another version is activated.`,
          ...(departments > 0 ? [`${departments} department assignments name this slug and will resolve to nothing.`] : []),
          ...(assignment?.tenantDefault ? ['This slug is the tenant default, so every department without an assignment of its own loses its fallback.'] : []),
          'Deprecation is not reversible: recover by activating another published version, or by publishing a new one.',
        ]
      : [`v${versionNumber} is not serving traffic, so nothing changes for callers resolving the slug today.`, 'It keeps its history and stays visible here, but it can never be activated again.']),
  ];

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Deprecate v${versionNumber}?`}
      description={`Deprecation retires a published version of ${slug}. The version and its history are kept.`}
      body={
        <ul className="list-disc space-y-1 pl-5">
          {consequences.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      }
      confirmLabel={`Deprecate v${versionNumber}`}
      destructive={isActive}
      typeToConfirm={isActive ? slug : undefined}
      onConfirm={onConfirm}
      isPending={isPending}
    />
  );
}
