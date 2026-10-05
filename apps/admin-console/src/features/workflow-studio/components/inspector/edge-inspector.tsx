'use client';

/**
 * `EdgeInspector` — TASK-1036 §3.6: the inspector opens for a LINK too. It names the two steps
 * (by label), the sockets the wire uses, what the link carries (`transcript → message`, read off
 * the target's bindings — data moves by bindings, OD-29), the branch it leaves by, and offers
 * Delete. A mapping is changed where it is bound, so each end is one click away.
 */
import { Badge, Button } from '@arcaai/ui';
import { IconTrash } from '@tabler/icons-react';
import type { AgentIOResolver } from '@arcaai/workflow-contract';
import type { GraphStoreEdge, GraphStoreNode } from '../../store/types';
import { edgeMappingLabels } from '../../lib/connection-plan';
import { branchHandlesOf } from '../../lib/core-ports';
import { nodeDisplayName } from '../../lib/node-identity';
import { useNodeNamingContext } from '../node-naming-context';

export interface EdgeInspectorProps {
  edge: GraphStoreEdge;
  nodes: readonly GraphStoreNode[];
  edges: readonly GraphStoreEdge[];
  agents: AgentIOResolver;
  onDelete: (edgeId: string) => void;
  onSelectNode: (nodeId: string) => void;
  readOnly?: boolean;
}

export function EdgeInspector({ edge, nodes, edges, agents, onDelete, onSelectNode, readOnly }: EdgeInspectorProps) {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  const mapping = edgeMappingLabels(nodes, edges, agents).get(edge.id);
  const naming = useNodeNamingContext();
  const sourceName = source ? nodeDisplayName(source, nodes, naming) : 'a removed step';
  const targetName = target ? nodeDisplayName(target, nodes, naming) : 'a removed step';
  const branch = source && branchHandlesOf(source.type, source.config).includes(edge.sourceHandle) ? edge.sourceHandle : null;
  const condition =
    branch && source?.type === 'core.condition' && Array.isArray(source.config.branches)
      ? (source.config.branches as Array<{ key?: unknown; when?: unknown }>).find((entry) => entry.key === branch)?.when
      : undefined;

  return (
    <section aria-label="Link" className="flex flex-col gap-3" data-slot="edge-inspector">
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Link</p>
        <h2 className="text-sm font-medium">
          {sourceName} → {targetName}
        </h2>
        <p className="text-muted-foreground font-mono text-xs">
          {edge.sourceHandle} → {edge.targetHandle}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">From</dt>
        <dd>
          <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => onSelectNode(edge.source)}>
            Open {sourceName}
          </Button>
        </dd>
        <dt className="text-muted-foreground">To</dt>
        <dd>
          <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => onSelectNode(edge.target)}>
            Open {targetName}
          </Button>
        </dd>
        {branch ? (
          <>
            <dt className="text-muted-foreground">Path</dt>
            <dd className="flex flex-col gap-0.5">
              <Badge variant="outline" className="self-start font-mono">
                {branch}
              </Badge>
              {typeof condition === 'string' && condition ? <code className="text-muted-foreground text-xs">{condition}</code> : null}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Carries</dt>
        <dd>{mapping ? <span className="font-mono text-xs">{mapping.label}</span> : <span className="text-muted-foreground text-xs">Order only — no data. Bind inputs in the next step.</span>}</dd>
      </dl>
      {!readOnly ? (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onDelete(edge.id)}>
          <IconTrash aria-hidden="true" />
          Delete this link
        </Button>
      ) : null}
      <p className="text-muted-foreground text-xs">Deleting a link also clears the inputs that read {sourceName} if it no longer runs before {targetName}.</p>
    </section>
  );
}
