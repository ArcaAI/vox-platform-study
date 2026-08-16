'use client';

/**
 * `WorkflowStudioScreen` (TASK-719 Task 16) — the `/workflow-studio/[definitionId]` route body.
 * `definitionId === 'new'` renders the create form (README/Task 16 approach: a definition must
 * exist server-side, with a `paletteKey`, before the graph editor can open — there is no local
 * "unsaved new definition" editing mode). Otherwise fetches the definition + node registry and
 * hands them to `WorkflowStudioEditor` once both are ready — `<Skeleton>` shapes match the
 * three-column editor layout (rail · canvas · inspector) while loading (rule 10).
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
      <ScreenTemplate contentMode="fill" header={<Skeleton className="h-8 w-64" />}>
        <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr_320px] gap-4">
          <Skeleton className="h-full w-full" />
          <Skeleton className="h-full w-full" />
          <Skeleton className="h-full w-full" />
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
