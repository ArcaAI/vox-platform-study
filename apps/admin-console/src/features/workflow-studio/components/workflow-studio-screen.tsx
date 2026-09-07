'use client';

/**
 * `WorkflowStudioScreen` — the body of BOTH studio routes.
 *
 * TASK-893 OD-1/OD-3 — there is no definitions grid any more, so `/workflow-studio` (no id) is a
 * RESOLVER: it reads the tenant's definitions and replaces the URL with the canonical deep link
 * `/workflow-studio/<id>` for the one an admin most likely wants to work on (the newest editable
 * draft, else the newest row). That keeps a shared link, a refresh and the header's workflow
 * switcher all naming the same thing, instead of a bare `/workflow-studio` that means "whatever
 * happened to load first". With no definitions at all it shows the create affordances that used
 * to live on the grid.
 *
 * `definitionId === 'new'` renders the create form: a definition must exist server-side, with a
 * `paletteKey`, before the graph editor can open — there is no local "unsaved new definition"
 * editing mode. Otherwise it fetches the definition + node registry and hands them to
 * `WorkflowStudioEditor` once both are ready; `<Skeleton>` shapes match the three-column editor
 * layout (rail · canvas · inspector) while loading (rule 10).
 *
 * No `StatusFooter` here, deliberately. The screen's real frame — `ScreenTemplate` with
 * `contentMode="fill"` and the graph's status bar — belongs to `WorkflowStudioEditor`, which this
 * file delegates to. The frames left in THIS file are the create form, the error state, the empty
 * state and the loading skeleton; none of them has a count, a connection state or a last-updated
 * to pin, and an empty status bar under a two-field form would be chrome for its own sake
 * (rule 11 §2: no wrapper that only adds padding).
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { IconFileImport, IconListTree, IconPlus, IconTemplate } from '@tabler/icons-react';
import { Button, Skeleton } from '@arcaai/ui';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { GatewayError } from '@/shared/api';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import {
  useCloneWorkflowDefinition,
  useImportWorkflowDefinition,
  useWorkflowDefinition,
  useWorkflowDefinitions,
  useWorkflowNodeRegistry,
  useWorkflowTemplates,
} from '../api';
import type { WorkflowDefinition } from '../api/types';
import { CreateDefinitionForm } from './create-definition-form';
import { WorkflowStudioEditor } from './workflow-studio-editor';
import { CloneDefinitionDialog, type CloneDefinitionSubmission } from './clone-definition-dialog';
import { ImportDefinitionDialog, type ImportDefinitionSubmission } from './import-definition-dialog';

const RESOLVER_PAGE_SIZE = 100;

function EditorLoadingSkeleton() {
  return (
    <div aria-hidden="true">
      <ScreenTemplate contentMode="fill" header={<Skeleton className="h-8 w-64" />}>
        {/*
          Mirrors the editor's own reflow gate AND its column widths so the skeleton has the
          loaded shape at every zoom level, not just on a wide desktop (rule 10 §3).
        */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 [@media(min-width:64rem)_and_(min-height:32rem)]:grid-cols-[260px_minmax(0,1fr)_360px]">
          <Skeleton className="h-40 w-full [@media(min-width:64rem)_and_(min-height:32rem)]:h-full" />
          <Skeleton className="h-[26rem] w-full [@media(min-width:64rem)_and_(min-height:32rem)]:h-full" />
          <Skeleton className="h-40 w-full [@media(min-width:64rem)_and_(min-height:32rem)]:h-full" />
        </div>
      </ScreenTemplate>
    </div>
  );
}

/**
 * Which definition `/workflow-studio` opens. A DRAFT/VALIDATED row is editable and a PUBLISHED one
 * is not, so landing on the newest editable row is the one choice that does not open the studio in
 * a state where every gesture is refused — the exact complaint TASK-893 exists to answer. Falls
 * back to the newest row of any status when the tenant has only published versions.
 */
export function pickDefaultDefinition(rows: readonly WorkflowDefinition[]): WorkflowDefinition | null {
  if (rows.length === 0) return null;
  const newest = (candidates: readonly WorkflowDefinition[]) =>
    [...candidates].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
  return newest(rows.filter((row) => row.status === 'DRAFT' || row.status === 'VALIDATED')) ?? newest(rows);
}

function DefaultDefinitionResolver() {
  const router = useRouter();
  const definitionsQuery = useWorkflowDefinitions({ page: 0, limit: RESOLVER_PAGE_SIZE });
  const rows = definitionsQuery.data?.data;
  const target = rows ? pickDefaultDefinition(rows) : null;

  useEffect(() => {
    // `replace`, not `push`: `/workflow-studio` is an alias for "the studio", so it must not add a
    // history entry the Back button bounces off straight back into this same redirect.
    if (target) router.replace(`/workflow-studio/${encodeURIComponent(target.id)}`);
  }, [target, router]);

  if (definitionsQuery.isLoading) return <EditorLoadingSkeleton />;
  if (definitionsQuery.error) {
    return (
      <ScreenTemplate header={<PageHeader title="Workflow Studio" />}>
        <ErrorState error={definitionsQuery.error} onRetry={() => void definitionsQuery.refetch()} />
      </ScreenTemplate>
    );
  }
  if (target) return <EditorLoadingSkeleton />;

  return <EmptyStudio />;
}

/**
 * The tenant has no workflows at all. The three ways to get a first one — blank, from the SYSTEM
 * template library, from an exported bundle — all lived on the deleted definitions grid, and every
 * one of them has to survive it: an empty tenant cannot reach the studio header's copies, because
 * the header only exists once a workflow is open.
 */
function EmptyStudio() {
  const router = useRouter();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  // Deferred until the dialog opens — the library is a cross-tenant read nobody needs on a page
  // load that may never reach the clone flow.
  const templatesQuery = useWorkflowTemplates(cloneOpen);
  const cloneMutation = useCloneWorkflowDefinition();
  const importMutation = useImportWorkflowDefinition();

  async function handleClone({ sourceId, targetSlug, name }: CloneDefinitionSubmission) {
    setCloneError(null);
    try {
      const created = await cloneMutation.mutateAsync({ sourceId, body: { targetSlug, name } });
      setCloneOpen(false);
      toast.success(`Cloned into “${created.name}”.`);
      router.push(`/workflow-studio/${encodeURIComponent(created.id)}`);
    } catch (cause) {
      // The gateway's own message names the colliding slug, the exceeded quota, or the nodes
      // whose bindings block a template clone.
      const message = cause instanceof GatewayError ? cause.message : 'Failed to clone the workflow.';
      setCloneError(message);
      toast.error(message);
    }
  }
  async function handleImport({ targetSlug, name, bundle }: ImportDefinitionSubmission) {
    setImportError(null);
    try {
      const created = await importMutation.mutateAsync({ targetSlug, name, bundle });
      setImportOpen(false);
      toast.success(`Imported “${created.name}” as a draft — validate it before publishing.`);
      router.push(`/workflow-studio/${encodeURIComponent(created.id)}`);
    } catch (cause) {
      // Surfaced VERBATIM: the gateway's 409 names the references this tenant is missing, and a
      // paraphrase would drop exactly the part that makes it actionable.
      const message = cause instanceof GatewayError ? cause.message : 'Failed to import the workflow.';
      setImportError(message);
      toast.error(message);
    }
  }

  return (
    <ScreenTemplate header={<PageHeader title="Workflow Studio" meta={<span>Author, validate and publish workflow definitions for this tenant.</span>} />}>
      <EmptyState
        icon={IconListTree}
        title="No workflow definitions yet"
        description="Start from a platform template, import a bundle another tenant exported, or build one from scratch — the studio renders whatever node types the registry serves."
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              onClick={() => {
                setCloneError(null);
                setCloneOpen(true);
              }}
            >
              <IconTemplate aria-hidden />
              Start from template
            </Button>
            <Button variant="outline" onClick={() => router.push('/workflow-studio/new')}>
              <IconPlus aria-hidden />
              New definition
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setImportError(null);
                setImportOpen(true);
              }}
            >
              <IconFileImport aria-hidden />
              Import
            </Button>
          </div>
        }
      />
      <CloneDefinitionDialog
        open={cloneOpen}
        onOpenChange={(next) => {
          setCloneOpen(next);
          if (!next) setCloneError(null);
        }}
        source={null}
        templates={templatesQuery.data ?? []}
        templatesLoading={templatesQuery.isLoading}
        onConfirm={(submission) => void handleClone(submission)}
        confirming={cloneMutation.isPending}
        error={cloneError}
      />
      <ImportDefinitionDialog
        open={importOpen}
        onOpenChange={(next) => {
          setImportOpen(next);
          if (!next) setImportError(null);
        }}
        onConfirm={(submission) => void handleImport(submission)}
        confirming={importMutation.isPending}
        error={importError}
      />
    </ScreenTemplate>
  );
}

function ExistingDefinitionBody({ definitionId }: { definitionId: string }) {
  const definitionQuery = useWorkflowDefinition(definitionId);
  const registryQuery = useWorkflowNodeRegistry();

  if (definitionQuery.isLoading || registryQuery.isLoading) return <EditorLoadingSkeleton />;

  if (definitionQuery.error) {
    return (
      <ScreenTemplate header={<PageHeader title="Workflow Studio" />}>
        <ErrorState error={definitionQuery.error} onRetry={() => void definitionQuery.refetch()} />
      </ScreenTemplate>
    );
  }
  if (!definitionQuery.data) return null;

  return <WorkflowStudioEditor definition={definitionQuery.data.data} etag={definitionQuery.data.etag} registryNodes={registryQuery.data?.nodes ?? []} />;
}

export function WorkflowStudioScreen({ definitionId }: { definitionId?: string }) {
  return (
    <WorkingTenantGate
      title="Workflow Studio"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/workflow-definitions{definitionId ? `/${definitionId}` : ''}
        </span>
      }
      description="Workflow definitions are tenant-scoped. Pick a working tenant from the top-bar switcher to load them."
    >
      {definitionId === undefined ? (
        <DefaultDefinitionResolver />
      ) : definitionId === 'new' ? (
        <ScreenTemplate header={<PageHeader title="New workflow definition" />}>
          <CreateDefinitionForm />
        </ScreenTemplate>
      ) : (
        <ExistingDefinitionBody definitionId={definitionId} />
      )}
    </WorkingTenantGate>
  );
}
