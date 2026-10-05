'use client';

/**
 * TASK-1036 C2b — the composer's shared reads, so the canvas, the inspector, the picker and the
 * settings dialog all see ONE graph, ONE agent resolver and ONE context schema.
 *
 *  - the graph (nodes, edges, `graph.settings`) from the editor's store — `null` outside a
 *    `GraphStoreProvider`, which is how an inspector field rendered standalone (its own unit test,
 *    an older mount) degrades to its pre-composer behaviour instead of throwing;
 *  - the agents (`GET admin/agents`, the SAME cached query the agent picker runs) as the
 *    contract's `AgentIOResolver` — task + output schema per slug, which is what types an agent's
 *    ports (D-F) and its outputs in the picker;
 *  - the workflow's context schema (settings first, the trigger's binding for one release), its
 *    definition, name and version, for the picker's Context group.
 */
import { useMemo } from 'react';
import type { AgentIOResolver, WorkflowSettings } from '@arcaai/workflow-contract';
import { useContextSchemaCatalog, useContextSchemaDefinition } from '@/shared/catalog';
import { useAgentOptions } from '../../api/hooks';
import type { AgentOption } from '../../api/types';
import { agentResolverOf } from '../../lib/composer-io';
import { settingsDraftOf } from '../../lib/settings-model';
import { useOptionalGraphStore, useOptionalGraphStoreApi, type GraphStoreApi } from '../../store';
import type { GraphStoreEdge, GraphStoreNode } from '../../store/types';

const NO_NODES: GraphStoreNode[] = [];
const NO_EDGES: GraphStoreEdge[] = [];

export interface ComposerData {
  storeApi: GraphStoreApi;
  nodes: GraphStoreNode[];
  edges: GraphStoreEdge[];
  settings: WorkflowSettings | undefined;
  agents: AgentIOResolver;
  agentOptions: AgentOption[];
  contextSchema: unknown;
  contextSchemaName: string | null;
  contextSchemaVersion: number | null;
  /** TASK-1036 R-C #7 — the studio's "Hide PHI" switch (view state in the store). */
  hidePhi: boolean;
}

/** The agents as the composer types them. `outputSchema` rides on `GET admin/agents` (`AgentResponse`). */
export function useComposerAgents(enabled = true): { agents: AgentIOResolver; agentOptions: AgentOption[] } {
  const query = useAgentOptions(undefined, enabled);
  return useMemo(() => {
    const agentOptions = query.data ?? [];
    return {
      agentOptions,
      agents: agentResolverOf(agentOptions.map((agent) => ({ slug: agent.slug, task: agent.task, outputSchema: (agent as AgentOption & { outputSchema?: unknown }).outputSchema }))),
    };
  }, [query.data]);
}

export function useComposerData(): ComposerData | null {
  const storeApi = useOptionalGraphStoreApi();
  const nodes = useOptionalGraphStore((state) => state.nodes, NO_NODES);
  const edges = useOptionalGraphStore((state) => state.edges, NO_EDGES);
  const settings = useOptionalGraphStore((state) => state.settings, undefined);
  const hidePhi = useOptionalGraphStore((state) => state.hidePhi, false);
  const { agents, agentOptions } = useComposerAgents(storeApi !== null);

  const schemaSetting = useMemo(() => settingsDraftOf(nodes, settings).contextSchema, [nodes, settings]);
  const reference = schemaSetting && 'contextSchemaId' in schemaSetting ? schemaSetting : null;
  const definition = useContextSchemaDefinition(reference?.contextSchemaId ?? null, reference?.versionNumber ?? null);
  const catalog = useContextSchemaCatalog();

  if (storeApi === null) return null;
  const inline = schemaSetting && 'inline' in schemaSetting ? schemaSetting.inline : null;
  return {
    storeApi,
    nodes,
    edges,
    settings,
    agents,
    agentOptions,
    contextSchema: inline ?? definition.definition ?? undefined,
    contextSchemaName: reference ? ((catalog.data ?? []).find((schema) => schema.id === reference.contextSchemaId)?.name ?? null) : null,
    contextSchemaVersion: reference ? (reference.versionNumber ?? null) : null,
    hidePhi,
  };
}
