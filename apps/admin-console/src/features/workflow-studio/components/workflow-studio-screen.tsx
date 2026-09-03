'use client';

/**
 * `WorkflowStudioScreen` — the `/workflow-studio/[definitionId]` route body.
 * `definitionId === 'new'` renders the create form (README/Task 16 approach: a definition must
 * exist server-side, with a `paletteKey`, before the graph editor can open — there is no local
 * "unsaved new definition" editing mode). Otherwise fetches the definition + node registry and
 * hands them to `WorkflowStudioEditor` once both are ready — `<Skeleton>` shapes match the
 * three-column editor layout (rail · canvas · inspector) while loading (rule 10).
 *
 * No `StatusFooter` here, deliberately. The screen's real frame — `ScreenTemplate` with the
 * `viewMode`-driven `contentMode` and the graph's status bar — belongs to `WorkflowStudioEditor`,
 * which this file delegates to. The three frames left in THIS file are the create form, the
 * error state and the loading skeleton; none of them has a count, a connection state or a
 * last-updated to pin, and an empty status bar under a two-field form would be chrome for its
 * own sake (rule 11 §2: no wrapper that only adds padding).
 */
import { Skeleton } from '@arcaai/ui';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useWorkflowDefinition, useWorkflowNodeRegistry } from '../api';
import { CreateDefinitionForm } from './create-definition-form';
import { WorkflowStudioEditor } from './workflow-studio-editor';

function EditorLoadingSkeleton() {
  return (
    <div aria-hidden="true">
      <ScreenTemplate header={<Skeleton className="h-8 w-64" />}>
        {/*
 Mirrors the editor's own reflow gate so the skeleton has the loaded shape at every
            zoom level, not just on a wide desktop (rule 10 §3).
*/}
        <div className="grid min-h-0 grid-cols-1 gap-4 [@media(min-width:64rem)_and_(min-height:32rem)]:h-full [@media(min-width:64rem)_and_(min-height:32rem)]:grid-cols-[240px_1fr_320px]">
          <Skeleton className="h-40 w-full [@media(min-width:64rem)_and_(min-height:32rem)]:h-full" />
          <Skeleton className="h-[26rem] w-full [@media(min-width:64rem)_and_(min-height:32rem)]:h-full" />
          <Skeleton className="h-40 w-full [@media(min-width:64rem)_and_(min-height:32rem)]:h-full" />
        </div>
      </ScreenTemplate>
    </div>
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

export function WorkflowStudioScreen({ definitionId }: { definitionId: string }) {
  const isNew = definitionId === 'new';
  return (
    <WorkingTenantGate
      title="Workflow Studio"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/workflow-definitions/{definitionId}
        </span>
      }
      description="Workflow definitions are tenant-scoped. Pick a working tenant from the top-bar switcher to load this definition."
    >
      {isNew ? (
        <ScreenTemplate header={<PageHeader title="New workflow definition" />}>
          <CreateDefinitionForm />
        </ScreenTemplate>
      ) : (
        <ExistingDefinitionBody definitionId={definitionId} />
      )}
    </WorkingTenantGate>
  );
}
