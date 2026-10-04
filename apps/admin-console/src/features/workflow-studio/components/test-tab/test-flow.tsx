'use client';

/**
 * The Test tab's Flow (TASK-1036 §10.2): the composer's own canvas, read-only, with the run laid
 * over it — every step Waiting / Running / Done with its duration, its run warnings counted on the
 * node, the links that carried data lit, and the active one animated (never under
 * `prefers-reduced-motion`). Clicking a step selects it (the store's selection, shared with the
 * Composer, so the inspector opens on the same step).
 */
import { useId, useMemo } from 'react';
import { Badge, Empty, EmptyDescription, EmptyMedia, EmptyTitle, Skeleton } from '@arcaai/ui';
import { IconTopologyStar3 } from '@tabler/icons-react';
import type { RunView } from '@/shared/sandbox/api/run-fold';
import { useWorkflowNodeRegistry } from '../../api/hooks';
import { selectEdges, selectNodes, useGraphStore } from '../../store';
import { ComposerCanvas } from '../canvas';
import { edgeRunStates, edgeStyleSheet, flowRunStates, runWarningFindings } from './lib/flow-state';
import { Panel } from './panel';

export function TestFlow({ view }: { view: RunView }) {
  const scopeId = useId();
  const nodes = useGraphStore(selectNodes);
  const edges = useGraphStore(selectEdges);
  const registry = useWorkflowNodeRegistry();
  const descriptorByType = useMemo(() => new Map((registry.data?.nodes ?? []).map((descriptor) => [descriptor.type, descriptor])), [registry.data]);

  const runStates = useMemo(() => flowRunStates(nodes, view), [nodes, view]);
  const findings = useMemo(() => runWarningFindings(view), [view]);
  const sheet = useMemo(() => edgeStyleSheet(scopeId, edgeRunStates(edges, view)), [scopeId, edges, view]);

  return (
    <Panel
      title="Flow"
      actions={
        <ul className="text-muted-foreground flex items-center gap-2 text-xs" aria-label="Legend">
          <li>
            <Badge variant="outline">Waiting</Badge>
          </li>
          <li>
            <Badge variant="secondary">Running</Badge>
          </li>
          <li>
            <Badge variant="default">Done</Badge>
          </li>
        </ul>
      }
    >
      {registry.isLoading ? (
        <Skeleton className="h-[26rem] w-full" />
      ) : (
        <div className="h-[26rem] min-h-0" data-test-flow={scopeId}>
          {sheet ? <style>{sheet}</style> : null}
          <ComposerCanvas
            aria-label="Test run flow"
            descriptorByType={descriptorByType}
            readOnly
            runStates={runStates}
            findings={findings}
            emptyState={
              <Empty>
                <EmptyMedia variant="icon">
                  <IconTopologyStar3 aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No steps yet</EmptyTitle>
                <EmptyDescription>Add steps in the Composer, save, then test the workflow here.</EmptyDescription>
              </Empty>
            }
          />
        </div>
      )}
    </Panel>
  );
}
