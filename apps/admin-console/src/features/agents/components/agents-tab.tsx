'use client';

/**
 * Agents tab — the Agent Catalog: department-grouped `DepartmentAgent`
 * rows over the `admin/department-agents` API. One row = one "Agent"
 * (admin vocabulary, Family 6: Agent Template → Agent → Version → Default →
 * Draft). Uses the console-wide `DetailDrawer` for create/edit, exactly like
 * the sibling Agent Templates tab.
 */

import { useMemo, useState } from 'react';
import { IconLock, IconPlus, IconRobot } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useDeleteDepartmentAgent, useDepartmentAgents, useDepartments, useSetDefaultDepartmentAgent, useTemplates } from '../api/hooks';
import type { Department, DepartmentAgent } from '../api/types';
import { DepartmentAgentDetailDrawer } from './agent-detail-drawer';
import { AgentRoleBadge } from './agent-loop-config-tab';

/** "Pinned to vN" vs "Tracking latest approved (vN)" — the movable-pointer distinction. */
export function versionStateLabel(agent: DepartmentAgent, templateCurrentVersion: number | undefined): string {
  if (agent.pinnedVersionNumber != null) return `Pinned to v${agent.pinnedVersionNumber}`;
  return templateCurrentVersion !== undefined ? `Tracking latest approved (v${templateCurrentVersion})` : 'Tracking latest approved';
}

function AgentRow({ agent, templateVersion, onSelect }: { agent: DepartmentAgent; templateVersion: number | undefined; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="hover:bg-muted flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-md p-2 text-left"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium">{agent.name}</span>
          {agent.isDefault ? <Badge>Default</Badge> : null}
          <AgentRoleBadge role={agent.role} />
          {agent.templateLocked ? (
            <Badge variant="outline" className="gap-1">
              <IconLock aria-hidden className="size-3" />
              Cloned from library
            </Badge>
          ) : null}
        </span>
        <span className="text-muted-foreground shrink-0 font-mono text-xs">{versionStateLabel(agent, templateVersion)}</span>
      </button>
    </li>
  );
}

function DepartmentGroup({
  department,
  agents,
  templateVersionById,
  onSelect,
}: {
  department: Department;
  agents: DepartmentAgent[];
  templateVersionById: Map<string, number>;
  onSelect: (agent: DepartmentAgent) => void;
}) {
  return (
    <Card className="gap-2 p-4">
      <h3 className="flex items-baseline gap-2 text-sm font-semibold">
        {department.code ?? department.name ?? department.id}
        <span className="text-muted-foreground text-xs font-normal">
          {agents.length} agent{agents.length === 1 ? '' : 's'}
        </span>
      </h3>
      <ul className="flex flex-col gap-1">
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} templateVersion={templateVersionById.get(agent.promptTemplateId)} onSelect={() => onSelect(agent)} />
        ))}
      </ul>
    </Card>
  );
}

function AgentsTabSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="flex flex-col gap-2 rounded-md border p-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * The Agents tab body (frame 32, `/agents?tab=agents` — the default landing
 * tab). Fetches the whole tenant catalog in one page (admin scale) and groups
 * client-side by department; each department's own agent count is the only
 * pagination this surface needs.
 */
export function AgentsTab() {
  const [selectedParam, setSelectedParam] = useQueryState('agent', parseAsString.withDefault(''));
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<DepartmentAgent | null>(null);

  const agentsQuery = useDepartmentAgents({ limit: 200 });
  const departmentsQuery = useDepartments();
  const templatesQuery = useTemplates({ limit: 200 });
  const deleteAgent = useDeleteDepartmentAgent();
  const setDefault = useSetDefaultDepartmentAgent();

  // `?? []` fallbacks stay INSIDE each useMemo (keyed on the query's own
  // `.data` reference) rather than on a freshly-allocated `[]` literal on
  // every render — the latter would defeat the memoization entirely.
  const agents = useMemo(() => agentsQuery.data?.data ?? [], [agentsQuery.data]);
  const departments = useMemo(() => departmentsQuery.data ?? [], [departmentsQuery.data]);
  const selected = agents.find((agent) => agent.id === selectedParam) ?? null;

  const templateVersionById = useMemo(
    () => new Map((templatesQuery.data?.data ?? []).map((template) => [template.id, template.currentVersionNumber])),
    [templatesQuery.data],
  );
  const departmentLabelById = useMemo(
    () => new Map(departments.map((department) => [department.id, (department.code ?? department.name ?? department.id) as string])),
    [departments],
  );

  const byDepartment = useMemo(() => {
    const map = new Map<string, DepartmentAgent[]>();
    for (const agent of agents) {
      const list = map.get(agent.departmentId) ?? [];
      list.push(agent);
      map.set(agent.departmentId, list);
    }
    return map;
  }, [agents]);

  const groups = departments.filter((department) => (byDepartment.get(department.id) ?? []).length > 0);
  // Agents whose department row isn't in the directory (edge case) still render.
  const orphanDepartmentIds = [...byDepartment.keys()].filter((id) => !departments.some((department) => department.id === id));

  function handleSetDefault(agent: DepartmentAgent) {
    setDefault.mutate(agent.id, {
      onSuccess: () => toast.success(`"${agent.name}" is now the department default`),
      onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not set the default agent.'),
    });
  }

  function handleDeleteConfirmed() {
    if (!deleting) return;
    deleteAgent.mutate(deleting.id, {
      onSuccess: () => {
        toast.success('Agent deleted');
        if (deleting.id === selectedParam) void setSelectedParam(null);
        setDeleting(null);
      },
      onError: (error) => {
        toast.error(error instanceof GatewayError ? error.message : 'Could not delete the agent.');
        setDeleting(null);
      },
    });
  }

  if (agentsQuery.isPending) return <AgentsTabSkeleton />;
  if (agentsQuery.error) return <ErrorState error={agentsQuery.error} onRetry={() => void agentsQuery.refetch()} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">Agent Catalog ({agents.length})</h2>
          <p className="text-muted-foreground text-sm">
            One row per department Agent: an Agent Template bound to a department, pinned or tracking its latest approved Version.
          </p>
        </div>
        {agents.length > 0 ? (
          <Button onClick={() => setCreating(true)}>
            <IconPlus aria-hidden />
            New agent
          </Button>
        ) : null}
      </div>

      {agents.length === 0 ? (
        <EmptyState
          icon={IconRobot}
          title="No agents yet"
          description="Create an agent to bind a department to an Agent Template, pin a Version, and set the clinicians' Default."
          action={
            <Button onClick={() => setCreating(true)}>
              <IconPlus aria-hidden />
              New agent
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((department) => (
            <DepartmentGroup
              key={department.id}
              department={department}
              agents={byDepartment.get(department.id) ?? []}
              templateVersionById={templateVersionById}
              onSelect={(agent) => void setSelectedParam(agent.id)}
            />
          ))}
          {orphanDepartmentIds.map((departmentId) => (
            <DepartmentGroup
              key={departmentId}
              department={{ id: departmentId, isRootDepartment: false, createdAt: '', updatedAt: '', version: 1 }}
              agents={byDepartment.get(departmentId) ?? []}
              templateVersionById={templateVersionById}
              onSelect={(agent) => void setSelectedParam(agent.id)}
            />
          ))}
        </div>
      )}

      <DepartmentAgentDetailDrawer
        key={creating ? 'create' : selected?.id || 'no-agent'}
        agentId={creating ? null : (selected?.id ?? null)}
        creating={creating}
        departmentLabel={selected ? (departmentLabelById.get(selected.departmentId) ?? selected.departmentId) : null}
        onOpenChange={(open) => {
          if (open) return;
          setCreating(false);
          void setSelectedParam(null);
        }}
        onCreated={(agent) => {
          setCreating(false);
          void setSelectedParam(agent.id);
        }}
        onRequestDelete={setDeleting}
        onSetDefault={handleSetDefault}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete agent?"
        description={deleting ? `Soft-deletes "${deleting.name}". Its version history and the bound Agent Template stay in the database.` : ''}
        confirmLabel="Delete agent"
        destructive
        typeToConfirm={deleting?.name}
        onConfirm={handleDeleteConfirmed}
        isPending={deleteAgent.isPending}
      />
    </div>
  );
}
