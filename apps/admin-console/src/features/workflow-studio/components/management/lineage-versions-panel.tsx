'use client';

/**
 * TASK-1036 §3.3 — the versions of ONE workflow lineage with their lifecycle verbs. It is the
 * content of BOTH the list screen's row drawer and the studio header's `VersionHistorySheet`, so
 * the two surfaces cannot drift: same rows, same verbs, same consequence-naming confirmations.
 *
 * Per-version verbs (gated on the row's own state, a disabled one states why — rule 11 §5):
 *   Open · Publish (DRAFT/VALIDATED, only with a passing STORED report) · Activate (PUBLISHED, not
 *   active) · Unpublish = deprecate (PUBLISHED) · Edit as new draft (PUBLISHED/DEPRECATED; a 409
 *   `OPEN_DRAFT_EXISTS` opens the draft that already exists) · Delete (never the active version).
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { IconArchive, IconGitBranch, IconPlayerPlay, IconRocket, IconTrash } from '@tabler/icons-react';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import {
  ActivateVersionDialog,
  DeprecateVersionDialog,
  DiscardDraftDialog,
  VersionHistoryPanel,
  type VersionRow,
  type VersionRowAction,
} from '@/shared/versioning';
import {
  useActivateDefinition,
  useCreateDraftFrom,
  useDeleteWorkflowDefinition,
  useDeprecateDefinition,
  usePublishWorkflowDefinition,
  useWorkflowLineageBySlug,
  useWorkflowLineageVersions,
} from '../../api';
import type { WorkflowDefinition, WorkflowLineage } from '../../api/types';

export const studioHref = (definitionId: string) => `/workflow-studio/${encodeURIComponent(definitionId)}`;

function problemMessage(error: unknown, fallback: string): string {
  return error instanceof GatewayError ? error.message : fallback;
}

function toVersionRow(version: WorkflowDefinition): VersionRow {
  const nodeCount = version.graph?.nodes?.length ?? 0;
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    label: version.name,
    isActive: version.isActive,
    createdAt: version.createdAt,
    validatedAt: version.validatedAt,
    publishedAt: version.publishedAt,
    deprecatedAt: version.deprecatedAt,
    updatedAt: version.updatedAt,
    checksum: version.compiledConfigChecksum,
    detail: (
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Nodes</dt>
        <dd className="font-mono">{nodeCount}</dd>
        <dt className="text-muted-foreground">Validation</dt>
        <dd>{version.validationReport ? (version.validationReport.ok ? 'Passing' : 'Failing') : 'Not validated'}</dd>
        <dt className="text-muted-foreground">Tags</dt>
        <dd className="font-mono">{version.tags.length ? version.tags.join(', ') : '—'}</dd>
      </dl>
    ),
  };
}

type Dialog = { kind: 'activate' | 'deprecate' | 'discard' | 'delete'; version: WorkflowDefinition } | null;

export interface LineageVersionsPanelProps {
  slug: string;
  /** The register row the caller already holds; resolved by slug when omitted. */
  lineage?: WorkflowLineage | null;
  /** Any version id of the lineage (the studio's current definition) — anchors `GET :id/versions`. */
  anchorId?: string | null;
  /** Called after the panel navigates into the studio, so a hosting sheet can close itself. */
  onNavigate?: () => void;
}

export function LineageVersionsPanel({ slug, lineage: lineageProp, anchorId, onNavigate }: LineageVersionsPanelProps) {
  const router = useRouter();
  const resolved = useWorkflowLineageBySlug(slug, !lineageProp);
  const lineage = lineageProp ?? resolved.data ?? null;
  const anchor = anchorId ?? lineage?.active?.id ?? lineage?.draft?.id ?? null;
  const versionsQuery = useWorkflowLineageVersions(slug, anchor);
  const versions = useMemo(() => [...(versionsQuery.data ?? [])].sort((a, b) => b.versionNumber - a.versionNumber), [versionsQuery.data]);
  const byId = useMemo(() => new Map(versions.map((version) => [version.id, version])), [versions]);
  const activeVersion = versions.find((version) => version.isActive) ?? null;

  const publish = usePublishWorkflowDefinition();
  const activate = useActivateDefinition();
  const deprecate = useDeprecateDefinition();
  const remove = useDeleteWorkflowDefinition();
  const draftFrom = useCreateDraftFrom();
  const [dialog, setDialog] = useState<Dialog>(null);

  const label = lineage?.name ?? versions[0]?.name ?? slug;

  function open(id: string) {
    router.push(studioHref(id));
    onNavigate?.();
  }

  async function run(work: () => Promise<unknown>, success: string, failure: string) {
    try {
      await work();
      toast.success(success);
      setDialog(null);
    } catch (error) {
      toast.error(problemMessage(error, failure));
    }
  }

  async function editAsNewDraft(version: WorkflowDefinition) {
    try {
      const draft = await draftFrom.mutateAsync(version.id);
      toast.success(`Draft v${draft.versionNumber} created from v${version.versionNumber}.`);
      open(draft.id);
    } catch (error) {
      const body = error instanceof GatewayError ? (error.details as { code?: string; draftId?: string } | undefined) : undefined;
      if (error instanceof GatewayError && error.status === 409 && body?.code === 'OPEN_DRAFT_EXISTS' && body.draftId) {
        toast.info('This workflow already has an open draft — opening it.');
        open(body.draftId);
        return;
      }
      toast.error(problemMessage(error, 'Could not create a draft from that version.'));
    }
  }

  const actions = (row: VersionRow): VersionRowAction[] => {
    const version = byId.get(row.id);
    if (!version) return [];
    const list: VersionRowAction[] = [];
    const isOpenDraft = version.status === 'DRAFT' || version.status === 'VALIDATED';
    if (isOpenDraft) {
      const passing = version.validationReport?.ok === true;
      list.push({
        key: 'publish',
        label: 'Publish',
        icon: IconRocket,
        disabled: !passing,
        disabledReason: passing ? undefined : 'Validate it in the Studio first — no passing validation report is stored.',
        onSelect: () =>
          void run(() => publish.mutateAsync({ id: version.id }), `v${version.versionNumber} published and active.`, 'Could not publish that version.'),
      });
    }
    if (version.status === 'PUBLISHED' && !version.isActive) {
      list.push({ key: 'activate', label: 'Activate', icon: IconPlayerPlay, onSelect: () => setDialog({ kind: 'activate', version }) });
    }
    if (version.status === 'PUBLISHED') {
      list.push({ key: 'unpublish', label: 'Unpublish', icon: IconArchive, onSelect: () => setDialog({ kind: 'deprecate', version }) });
    }
    if (version.status === 'PUBLISHED' || version.status === 'DEPRECATED') {
      list.push({ key: 'edit-as-draft', label: 'Edit as new draft', icon: IconGitBranch, onSelect: () => void editAsNewDraft(version) });
    }
    if (!version.isActive) {
      list.push({
        key: 'delete',
        label: 'Delete',
        icon: IconTrash,
        destructive: true,
        onSelect: () => setDialog({ kind: isOpenDraft ? 'discard' : 'delete', version }),
      });
    }
    return list;
  };

  return (
    <>
      <VersionHistoryPanel
        aria-label={`Versions of ${slug}`}
        versions={versions.map(toVersionRow)}
        isPending={versionsQuery.isPending}
        error={versionsQuery.error}
        onRetry={() => void versionsQuery.refetch()}
        actions={actions}
        onOpenVersion={(row) => open(row.id)}
        caption={
          activeVersion
            ? `Every run of ${slug} uses the ACTIVE version, v${activeVersion.versionNumber}. Activating another published version moves that pointer; assignments follow it.`
            : `No version of ${slug} is active, so the slug resolves to nothing. Publish a draft or activate a published version to serve it again.`
        }
        emptyTitle="No versions yet"
        emptyDescription="This workflow has no live version rows."
      />

      {dialog?.kind === 'activate' ? (
        <ActivateVersionDialog
          open
          onOpenChange={(next) => !next && setDialog(null)}
          itemLabel={label}
          slug={slug}
          versionNumber={dialog.version.versionNumber}
          currentActiveVersionNumber={activeVersion?.versionNumber ?? null}
          assignment={lineage?.assignment}
          isPending={activate.isPending}
          onConfirm={() => run(() => activate.mutateAsync(dialog.version.id), `v${dialog.version.versionNumber} is now the active version.`, 'Could not activate that version.')}
        />
      ) : null}

      {dialog?.kind === 'deprecate' ? (
        <DeprecateVersionDialog
          open
          onOpenChange={(next) => !next && setDialog(null)}
          itemLabel={label}
          slug={slug}
          versionNumber={dialog.version.versionNumber}
          isActive={dialog.version.isActive}
          assignment={lineage?.assignment}
          isPending={deprecate.isPending}
          onConfirm={() => run(() => deprecate.mutateAsync(dialog.version.id), `v${dialog.version.versionNumber} unpublished.`, 'Could not unpublish that version.')}
        />
      ) : null}

      {dialog?.kind === 'discard' ? (
        <DiscardDraftDialog
          open
          onOpenChange={(next) => !next && setDialog(null)}
          itemLabel={label}
          slug={slug}
          versionNumber={dialog.version.versionNumber}
          isPending={remove.isPending}
          onConfirm={() => run(() => remove.mutateAsync(dialog.version.id), 'Draft discarded.', 'Could not discard that draft.')}
        />
      ) : null}

      {dialog?.kind === 'delete' ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => !next && setDialog(null)}
          title={`Delete v${dialog.version.versionNumber}?`}
          description={`The version is soft-deleted and disappears from the history of ${slug}. The active version and every other version are untouched.`}
          confirmLabel={`Delete v${dialog.version.versionNumber}`}
          destructive
          isPending={remove.isPending}
          onConfirm={() => run(() => remove.mutateAsync(dialog.version.id), `v${dialog.version.versionNumber} deleted.`, 'Could not delete that version.')}
        />
      ) : null}
    </>
  );
}
