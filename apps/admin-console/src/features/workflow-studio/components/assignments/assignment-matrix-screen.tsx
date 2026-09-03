'use client';

/**
 * Studio assignment-matrix screen ( half (a) Task 6, tier 30-49). WHICH
 * workflow definition governs a tenant/department for a palette — rows are
 * departments (+ a synthetic tenant-default row), columns are the code-owned
 * palettes, and each cell shows the resolved definition plus its source
 * (explicit / inherited-from-tenant / inherited-from-platform-default — never
 * by color alone). The Figma design gate is waived for this screen (owner
 * decision) — built directly against the existing design
 * system, per rule 12's "component-first" latitude for non-visual/backend-first
 * work generalized to this backend-first screen.
 *
 * A sub-route of Workflow Studio (`/workflow-studio/assignments`), not a tab —
 * the Studio owns `WorkflowDefinition` and this screen is its assignment
 * governance surface (rule 13 "one authoritative editor per backend resource").
 */
import { useMemo, useState } from 'react';
import { IconArrowLeft, IconRefresh } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Button, Skeleton } from '@arcaai/ui';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { ErrorState } from '@/shared/state/error-state';
import { TenantScopeBanner } from '@/shared/tenant-scope/tenant-scope-banner';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { findDepartmentAssignment, findTenantAssignment } from '../../lib/assignment-cascade';
import { workflowStudioKeys, useDepartmentOptions, useWorkflowAssignmentsForPalettes, useWorkflowDefinitions, useWorkflowNodeRegistry } from '../../api';
import type { WorkflowAssignment } from '../../api/types';
import { AssignmentEditDrawer, INHERIT_SENTINEL } from './assignment-edit-drawer';
import { AssignmentMatrixGrid, type MatrixCellTarget } from './assignment-matrix-grid';

/** Mirrors `PolicyTabSkeleton` (harness-policy) shape: a header row + a few body rows (rule 10). */
function MatrixSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <Skeleton className="h-9 w-64" />
      <div className="flex flex-col gap-2 rounded-md border p-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-11 w-full" />
        ))}
      </div>
    </div>
  );
}

function AssignmentMatrixBody() {
  const queryClient = useQueryClient();
  const departmentsQuery = useDepartmentOptions();
  const registryQuery = useWorkflowNodeRegistry();
  const definitionsQuery = useWorkflowDefinitions({ page: 0, limit: 200 });

  const paletteKeys = useMemo(() => {
    const nodes = registryQuery.data?.nodes ?? [];
    const keys = new Set<string>();
    for (const node of nodes) {
      if (node.paletteKey) keys.add(node.paletteKey);
    }
    return Array.from(keys).sort();
  }, [registryQuery.data]);

  const assignmentQueries = useWorkflowAssignmentsForPalettes(paletteKeys);
  const assignmentsByPalette = useMemo(() => {
    const map: Record<string, WorkflowAssignment[]> = {};
    paletteKeys.forEach((paletteKey, index) => {
      map[paletteKey] = assignmentQueries[index]?.data ?? [];
    });
    return map;
  }, [paletteKeys, assignmentQueries]);

  const [selected, setSelected] = useState<MatrixCellTarget | null>(null);

  function refetchAll() {
    void departmentsQuery.refetch();
    void registryQuery.refetch();
    void definitionsQuery.refetch();
    assignmentQueries.forEach((query) => void query.refetch());
  }

  const blockingError = departmentsQuery.error ?? registryQuery.error ?? definitionsQuery.error;
  const initialLoad =
    (departmentsQuery.isPending && !departmentsQuery.data) ||
    (registryQuery.isPending && !registryQuery.data) ||
    (definitionsQuery.isPending && !definitionsQuery.data) ||
    (paletteKeys.length > 0 && assignmentQueries.some((query) => query.isPending && !query.data));

  const definitionOptionsByPalette = useMemo(() => {
    const rows = definitionsQuery.data?.data ?? [];
    const map: Record<string, { slug: string; name: string }[]> = {};
    for (const definition of rows) {
      if (definition.status !== 'PUBLISHED' || !definition.isActive) continue;
      const bucket = map[definition.paletteKey] ?? [];
      if (!bucket.some((entry) => entry.slug === definition.slug)) {
        bucket.push({ slug: definition.slug, name: definition.name });
      }
      map[definition.paletteKey] = bucket;
    }
    return map;
  }, [definitionsQuery.data]);

  return (
    <ScreenTemplate
      contentMode="fill"
      header={
        <PageHeader
          title="Workflow Assignments"
          meta={
            <span aria-hidden className="text-muted-foreground font-mono text-xs">
              GET /admin/workflow-assignments
            </span>
          }
          actions={
            <>
              <Button variant="outline" asChild>
                <Link href="/workflow-studio">
                  <IconArrowLeft aria-hidden />
                  Workflow Studio
                </Link>
              </Button>
              <Button variant="outline" onClick={() => void queryClient.invalidateQueries({ queryKey: workflowStudioKeys.root })}>
                <IconRefresh aria-hidden />
                Refresh
              </Button>
            </>
          }
        />
      }
      statusBanner={<TenantScopeBanner />}
      footer={
        <StatusFooter
          start={<span>Department cells override the tenant default; the tenant default overrides the platform default.</span>}
          end={
            <span aria-hidden className="font-mono">
              PATCH requires If-Match
            </span>
          }
        />
      }
    >
      {initialLoad ? (
        <MatrixSkeleton />
      ) : blockingError ? (
        <ErrorState error={blockingError} onRetry={refetchAll} />
      ) : (
        <AssignmentMatrixGrid
          departments={departmentsQuery.data ?? []}
          paletteKeys={paletteKeys}
          assignmentsByPalette={assignmentsByPalette}
          onSelectCell={setSelected}
        />
      )}

      {selected ? (
        <AssignmentEditDrawer
          key={`${selected.scope}-${selected.scopeId ?? 'tenant'}-${selected.paletteKey}`}
          open
          onOpenChange={(next) => {
            if (!next) setSelected(null);
          }}
          scope={selected.scope}
          scopeId={selected.scopeId}
          scopeLabel={selected.scopeLabel}
          paletteKey={selected.paletteKey}
          paletteLabel={selected.paletteLabel}
          existing={
            selected.scope === 'TENANT'
              ? (findTenantAssignment(assignmentsByPalette[selected.paletteKey] ?? []) ?? null)
              : (findDepartmentAssignment(assignmentsByPalette[selected.paletteKey] ?? [], selected.scopeId ?? '') ?? null)
          }
          resolvedSlug={selected.cell.slug}
          resolvedSource={selected.cell.source}
          definitionOptions={definitionOptionsByPalette[selected.paletteKey] ?? []}
          onReloadLatest={() => {
            const index = paletteKeys.indexOf(selected.paletteKey);
            if (index >= 0) void assignmentQueries[index]?.refetch();
          }}
        />
      ) : null}
    </ScreenTemplate>
  );
}

export function AssignmentMatrixScreen() {
  return (
    <WorkingTenantGate
      title="Workflow Assignments"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/workflow-assignments
        </span>
      }
      description="Workflow assignments are tenant-scoped. Pick a working tenant from the top-bar switcher to load its matrix."
    >
      <AssignmentMatrixBody />
    </WorkingTenantGate>
  );
}

// Re-exported so tests / the drawer can reference the sentinel without a second definition.
export { INHERIT_SENTINEL };
