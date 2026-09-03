'use client';

import { useState } from 'react';
import { IconBolt } from '@tabler/icons-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime, formatNumber } from '@/shared/format';
import { AttemptGroup } from './attempt-group';
import { humanizeNodeType } from '../lib/graph-layout';
import { LoopIterationDrilldown, type LoopIterationState } from './loop-iteration-drilldown';
import { NodeRunBadge } from './node-run-badge';
import type { RunNodeRollup } from '../api/types';

/** Node types the drawer treats as loop containers — kept as one list so the
 *  registry key (`packages/workflow-contract/src/node-registry.ts`) is quoted once. */
const LOOP_NODE_TYPE = 'agentic.loop';

type DrawerTab = 'input' | 'output' | 'error';

/**
 * A PHI-posture notice, shown wherever a payload genuinely cannot be resolved.
 * `AgentTrajectoryStepResponse` strips `payloadRef` entirely rather than merely
 * redacting it (agent-trajectory.prisma's own "stats-first / payload-by-reference"
 * header) — there is nothing this drawer can dereference, so it says so rather
 * than rendering a misleadingly blank tab.
 */
function PayloadUnavailableNotice({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed p-3 text-sm">
      <p className="text-muted-foreground">
        {label} not available. Step payloads are stored by reference under a PHI posture and are never exposed through this read model.
      </p>
    </div>
  );
}

/**
 * Node-level detail for the run trace (Task 8, extended lane C step 6 into
 * Input/Output/Error tabs). The always-visible summary (status, timing, attempts)
 * sits ABOVE the tabs — the tabs are for the three things a debugger actually digs
 * into per node, matching the ticket's own wording.
 */
export function RunNodeDetailDrawer({
  open,
  nodeType,
  rollup,
  degraded,
  loopIterations,
  onLoopStep,
  liveOutputPreview,
  onOpenChange,
}: {
  open: boolean;
  /** The authored graph node's `type`, shown even when no rollup matched it (node never reached / no trace). */
  nodeType: string | null;
  rollup: RunNodeRollup | null;
  degraded?: boolean;
  /** Only meaningful when `nodeType === 'agentic.loop'` — see `LoopIterationDrilldown`'s own honesty note. */
  loopIterations?: LoopIterationState | null;
  onLoopStep?: (direction: -1 | 1) => void;
  /**
* Live-accumulated `workflow.token.delta` text for this exact node (lane C step 6/8;
   *  see `liveOutputByNodeId`'s own doc comment in `api/live-events.ts`). A PREVIEW only — never
   *  the durable output, and absent once the node settles and the connection's map is cleared. 
 */
  liveOutputPreview?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<DrawerTab>('output');
  const isLoop = nodeType === LOOP_NODE_TYPE;

  return (
    <Tabs value={tab} onValueChange={(next) => setTab(next as DrawerTab)}>
      <DetailDrawer
        open={open}
        onOpenChange={onOpenChange}
        title={nodeType ? humanizeNodeType(nodeType) : ''}
        meta={nodeType ? <code className="font-mono">{nodeType}</code> : null}
        tabs={
          rollup ? (
            <TabsList variant="line">
              <TabsTrigger value="input">Input</TabsTrigger>
              <TabsTrigger value="output">Output</TabsTrigger>
              <TabsTrigger value="error">Error</TabsTrigger>
            </TabsList>
          ) : null
        }
      >
        {rollup ? (
          <div className="flex flex-col gap-4">
            <NodeRunBadge rollup={rollup} degraded={degraded} />

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Started</dt>
              <dd>{formatDateTime(rollup.startedAt)}</dd>
              <dt className="text-muted-foreground">Ended</dt>
              <dd>{rollup.endedAt ? formatDateTime(rollup.endedAt) : 'In progress'}</dd>
              <dt className="text-muted-foreground">Duration</dt>
              <dd>{rollup.durationMs !== null ? `${formatNumber(rollup.durationMs)} ms` : '—'}</dd>
            </dl>

            <AttemptGroup rollup={rollup} />

            <TabsContent value="input" className="mt-0">
              <PayloadUnavailableNotice label="Input" />
            </TabsContent>
            <TabsContent value="output" className="mt-0 flex flex-col gap-4">
              {isLoop ? <LoopIterationDrilldown iterations={loopIterations ?? null} onStep={onLoopStep} /> : null}
              {liveOutputPreview ? (
                <div className="flex flex-col gap-1.5 rounded-md border p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <IconBolt aria-hidden className="size-4" />
                    Live output
                    <span className="text-muted-foreground text-xs font-normal">(streaming preview, not the durable record)</span>
                  </div>
                  <pre aria-live="polite" className="max-h-64 overflow-y-auto text-wrap whitespace-pre-wrap font-mono text-xs">
                    {liveOutputPreview}
                  </pre>
                </div>
              ) : (
                <PayloadUnavailableNotice label="Output" />
              )}
            </TabsContent>
            <TabsContent value="error" className="mt-0">
              {rollup.errorCode || rollup.status.toUpperCase() === 'ERROR' || rollup.status.toUpperCase() === 'TIMEOUT' ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Error code</dt>
                  <dd className="font-mono">{rollup.errorCode ?? '—'}</dd>
                  <dt className="text-muted-foreground">Status</dt>
                  <dd>{rollup.status}</dd>
                </dl>
              ) : (
                <p className="text-muted-foreground text-sm">No error was recorded for this node.</p>
              )}
            </TabsContent>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No trajectory step was recorded for this node in this run &mdash; it was not reached, or its correlation to a specific step could not be
            determined (node identity is derived from type + order; see the trace&rsquo;s known limitation).
          </p>
        )}
      </DetailDrawer>
    </Tabs>
  );
}
