'use client';

/**
 * TASK-965 §3.1 point 5 — the three consequence-naming confirmations.
 *
 * The rule these encode (the Vercel promote / Auth0 revert pattern): an irreversible lifecycle
 * action states what BECOMES true, what STOPS being true, and who is carried along, BEFORE it is
 * armed. "Are you sure?" is not a confirmation; it is a speed bump.
 *
 * The consequence that is easiest to get wrong is the assignment, because it points at a SLUG,
 * not a version. So activating a version silently MOVES every assignment forward (which is what
 * makes rollback safe), while deprecating the active version leaves every assignment pointing at
 * nothing and the lineage resolving to a fail-closed 503 (AG-4 — the old confirm never said so).
 * Two opposite consequences of the same fact, and only these dialogs can explain them.
 *
 * All three compose the console's own `ConfirmDialog` rather than opening a second `AlertDialog`
 * of their own, so the type-to-confirm arming, the acknowledgement rule, the destructive styling
 * and Radix's focus management stay defined in exactly one place.
 */
import type { ReactNode } from 'react';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import type { AssignmentSummary } from './state-badges';

interface LifecycleDialogBaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The human name of the lineage — an agent's or definition's display name. */
  itemLabel: string;
  /** The stable identifier assignments and SDK callers use; also the type-to-confirm phrase. */
  slug: string;
  versionNumber: number;
  isPending?: boolean;
  onConfirm: () => void | Promise<void>;
}

/** The consequences that follow from the lineage's assignments, as a list the admin reads. */
function assignmentConsequences(assignment: AssignmentSummary | undefined, verb: 'follow' | 'break'): ReactNode[] {
  const rows: ReactNode[] = [];
  const departments = assignment?.departmentCount ?? 0;
  const selectors = assignment?.selectorCount ?? 0;

  if (departments > 0) {
    rows.push(
      verb === 'follow'
        ? `${departments} department assignments name this slug and move with it.`
        : `${departments} department assignments name this slug and will resolve to nothing.`,
    );
  }
  if (assignment?.tenantDefault) {
    rows.push(
      verb === 'follow'
        ? 'This slug is the tenant default, so every department without an assignment of its own follows it too.'
        : 'This slug is the tenant default, so every department without an assignment of its own loses its fallback.',
    );
  }
  if (selectors > 0) {
    rows.push(`${selectors} of those assignments are narrowed by tag selectors and are carried unchanged.`);
  }
  if (rows.length === 0) {
    rows.push('Nothing is assigned to this slug today, so no traffic changes either way.');
  }
  return rows;
}

function ConsequenceList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

export interface ActivateVersionDialogProps extends LifecycleDialogBaseProps {
  /** The version serving today, or `null` when nothing is active (a deprecated or fresh lineage). */
  currentActiveVersionNumber?: number | null;
  assignment?: AssignmentSummary;
}

/**
 * The rollback verb (OD-965-1). Activation MOVES the pointer between published versions; it never
 * creates a version, which is why it is a separate verb from Publish and why the demoted sibling
 * stays published and re-activatable.
 */
export function ActivateVersionDialog({
  open,
  onOpenChange,
  itemLabel,
  slug,
  versionNumber,
  currentActiveVersionNumber,
  assignment,
  isPending,
  onConfirm,
}: ActivateVersionDialogProps) {
  const demoted = currentActiveVersionNumber ?? null;
  const consequences: ReactNode[] = [
    `v${versionNumber} becomes the active version of “${itemLabel}”.`,
    demoted === null
      ? 'No version is active today, so this is the first version this lineage will serve.'
      : `v${demoted} stops serving. It stays published and can be activated again at any time.`,
    ...assignmentConsequences(assignment, 'follow'),
  ];

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Activate v${versionNumber}?`}
      description={`Activation moves which published version the slug ${slug} serves. It does not create a new version and nothing is deleted.`}
      body={<ConsequenceList items={consequences} />}
      confirmLabel={`Activate v${versionNumber}`}
      onConfirm={onConfirm}
      isPending={isPending}
    />
  );
}

export interface DeprecateVersionDialogProps extends LifecycleDialogBaseProps {
  /** Whether the version being retired is the one currently serving. */
  isActive?: boolean;
  assignment?: AssignmentSummary;
}

/**
 * Retiring a published version. Deprecating the ACTIVE one is the consequential case: nothing
 * else is promoted in its place, so the lineage stops resolving — which is why that case, and
 * only that case, is type-to-confirm gated on the slug.
 */
export function DeprecateVersionDialog({
  open,
  onOpenChange,
  itemLabel,
  slug,
  versionNumber,
  isActive = false,
  assignment,
  isPending,
  onConfirm,
}: DeprecateVersionDialogProps) {
  const consequences: ReactNode[] = isActive
    ? [
        `v${versionNumber} is the active version, so “${itemLabel}” will stop resolving until another version is activated.`,
        ...assignmentConsequences(assignment, 'break'),
        'Deprecation is not reversible: recover by activating another published version, or by publishing a new one.',
      ]
    : [
        `v${versionNumber} is not serving traffic, so nothing changes for callers today.`,
        'It keeps its history and stays visible here, but it can never be activated again.',
      ];

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Deprecate v${versionNumber}?`}
      description={`Deprecation retires a published version of ${slug}. The version and its history are kept.`}
      body={<ConsequenceList items={consequences} />}
      confirmLabel={`Deprecate v${versionNumber}`}
      destructive={isActive}
      typeToConfirm={isActive ? slug : undefined}
      onConfirm={onConfirm}
      isPending={isPending}
    />
  );
}

export interface DiscardDraftDialogProps extends LifecycleDialogBaseProps {
  /** Override the type-to-confirm phrase; defaults to the slug. */
  confirmPhrase?: string;
}

/**
 * Discarding the open draft (WF-12: abandoned drafts were permanent because `DELETE :id` had no
 * console consumer, and a lineage accumulated identical-looking drafts — AG-19, the reported
 * symptom literally). The draft BODY is the only thing at risk, and it is unrecoverable, so this
 * is type-to-confirm gated even though no traffic moves.
 */
export function DiscardDraftDialog({
  open,
  onOpenChange,
  itemLabel,
  slug,
  versionNumber,
  confirmPhrase,
  isPending,
  onConfirm,
}: DiscardDraftDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Discard draft v${versionNumber}?`}
      description={`The open draft of “${itemLabel}” is deleted.`}
      body={
        <ConsequenceList
          items={[
            'Everything edited in this draft cannot be recovered — there is no undo and no restore.',
            'Published versions are untouched, and whichever one is active keeps serving.',
            `The next draft of ${slug} starts again from the active version.`,
          ]}
        />
      }
      confirmLabel={`Discard draft v${versionNumber}`}
      destructive
      typeToConfirm={confirmPhrase ?? slug}
      onConfirm={onConfirm}
      isPending={isPending}
    />
  );
}
