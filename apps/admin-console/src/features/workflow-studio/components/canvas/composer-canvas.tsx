'use client';

/**
 * `ComposerCanvas` — TASK-1036 §8.4 / §10.1, the composer's canvas. Wraps `@arcaai/ui`'s
 * `WorkflowCanvas` and owns every canvas gesture against the editor's graph store:
 *
 *  - TYPED PORTS (D-F): an agent shows its TASK's fields (`agentNodeIO`) as typed, shaped handles;
 *    every other node its NodeIO fields; an agent with no agent chosen keeps the primary dots.
 *  - CONNECT (§8.4 item 2): `isValidConnection` runs the same plan the commit runs
 *    (`connection-plan.ts`, `typeFits` underneath) and says WHY a pair is refused — in a live
 *    region and on the canvas. A committed link AUTO-MAPS: the best-fitting output is bound into
 *    the target's input (`config.inputs`, OD-29) over an ordering edge, and the link is labelled
 *    with the mapping (`transcript → message`). A branch link carries the router's input (Q3).
 *  - FAN-IN (OD-18): a second producer into an input that already has one is refused; the author
 *    is offered "Use first available", which binds an ordered coalesce (`firstOf`, Q1).
 *  - ADD A STEP THREE WAYS (§8.4 item 7): the palette (drag, handled here), `+` on a link (insert
 *    and re-wire with auto-map), and a link dropped on empty canvas — both open the searchable
 *    `NodePickerMenu`; "Add a step" is the keyboard path to the same menu (WCAG 2.5.7).
 *  - W1: Start and End refuse deletion with the reason; a required input with no source raises a
 *    canvas problem (§10.1), merged with the server's findings.
 *
 * MOUNT CONTRACT (lane C2a / the editor): render inside `GraphStoreProvider` in place of
 * `<WorkflowCanvas …>`, passing `descriptorByType` (the live registry) and, optionally, the
 * validation findings, the run overlay, the multi-selection and `fitViewKey`.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from '@arcaai/ui';
import { IconPlus } from '@tabler/icons-react';
import {
  WorkflowCanvas,
  type WorkflowCanvasEdge,
  type WorkflowCanvasEdgeRunState,
  type WorkflowCanvasNode,
  type WorkflowCanvasPort,
  type WorkflowCanvasRunState,
} from '@arcaai/ui/components/workflow-canvas';
import type { WorkflowFinding, WorkflowNodeDescriptor } from '../../api/types';
import { useGraphStore, useGraphStoreApi, selectEdges, selectNodes, selectSelectedEdgeId, selectSelectedNodeId, type InsertPlan } from '../../store';
import type { ConnectRequest, GraphStoreNode } from '../../store/types';
import { branchHandlesFor, primaryIoFor } from '../../lib/canvas-handles';
import { canvasPortsOf, ioTone, portHandleId, type PortView } from '../../lib/composer-io';
import { edgeMappingLabels, planConnection, type ConnectionPlan } from '../../lib/connection-plan';
import { inputRows } from '../../lib/inputs-model';
import { nodeDisplayName } from '../../lib/node-identity';
import { presetByKey } from '../../lib/palette-presets';
import { readPaletteDragPreset, readPaletteDragType } from '../../lib/palette-drag';
import { computeStepOrder } from '../../lib/step-order';
import { CORE_NODE_RENDERERS } from './core-node-renderers';
import { NodePickerMenu, type NodePickerChoice } from './node-picker-menu';
import { useComposerAgents } from './use-composer-data';

const LOOP_NODE_TYPE = 'core.loop';

export interface ComposerCanvasProps {
  'aria-label': string;
  descriptorByType: ReadonlyMap<string, WorkflowNodeDescriptor>;
  readOnly?: boolean;
  /** The latest validation report's findings (server side); merged with the composer's own. */
  findings?: readonly WorkflowFinding[];
  /** The run overlay: per-node state, wall time and warning count (the Test tab's live Flow, the Composer's view of the latest run). */
  runStates?: ReadonlyMap<string, { state?: WorkflowCanvasRunState; durationMs?: number; warnings?: number }>;
  /** The run overlay's links: `done` carried data, `active` is moving data now. Absent = no link is lit. */
  edgeRunStates?: ReadonlyMap<string, WorkflowCanvasEdgeRunState>;
  /**
   * Where "Add a step" sits. Default top-centre: the studio docks its floating palette top-left and
   * its inspector top-right, so neither corner is free for a button that must stay reachable.
   */
  addStepPlacement?: 'top-left' | 'top-center' | 'top-right';
  selectedNodeIds?: readonly string[];
  onSelectionChange?: (nodeIds: string[]) => void;
  fitViewKey?: number;
  emptyState?: ReactNode;
  className?: string;
}

const ADD_STEP_PLACEMENT: Record<NonNullable<ComposerCanvasProps['addStepPlacement']>, string> = {
  'top-left': 'top-2 left-2',
  'top-center': 'top-2 left-1/2 -translate-x-1/2',
  'top-right': 'top-2 right-2',
};

type MenuState =
  | { kind: 'insert'; edgeId: string; description: string }
  | { kind: 'connect'; from: { nodeId: string; handleId: string | null }; position: { x: number; y: number }; description: string }
  | { kind: 'add'; position: { x: number; y: number }; description: string };

interface CoalesceOffer {
  reason: string;
  apply: () => void;
}

function toCanvasPorts(ports: readonly PortView[], direction: 'in' | 'out'): WorkflowCanvasPort[] {
  return ports.map((port) => ({ id: portHandleId(direction, port.name), label: port.name, type: port.type, tone: ioTone(port.type), required: port.required }));
}

export function ComposerCanvas({
  'aria-label': ariaLabel,
  descriptorByType,
  readOnly = false,
  findings,
  runStates,
  edgeRunStates,
  addStepPlacement = 'top-center',
  selectedNodeIds,
  onSelectionChange,
  fitViewKey,
  emptyState,
  className,
}: ComposerCanvasProps) {
  const storeApi = useGraphStoreApi();
  const nodes = useGraphStore(selectNodes);
  const edges = useGraphStore(selectEdges);
  const selectedNodeId = useGraphStore(selectSelectedNodeId);
  const selectedEdgeId = useGraphStore(selectSelectedEdgeId);
  const { agents } = useComposerAgents();
  const [announcement, setAnnouncement] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [offer, setOffer] = useState<CoalesceOffer | null>(null);
  const lastRefusal = useRef<string | null>(null);
  const descriptors = useMemo(() => [...descriptorByType.values()], [descriptorByType]);

  const say = useCallback((message: string, asToast: boolean) => {
    setAnnouncement(message);
    if (asToast) toast.error(message);
  }, []);

  const plan = useCallback(
    (request: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }, replaceProducer?: string, graph = storeApi.getState()): ConnectionPlan =>
      planConnection({ nodes: graph.nodes, edges: graph.edges, descriptorByType, agents, ...request, ...(replaceProducer ? { replaceProducer } : {}) }),
    [storeApi, descriptorByType, agents],
  );

  /** Commits a planned link: the edge (with its binding, one undo step), or the binding alone. */
  const commitPlan = useCallback(
    (result: Extract<ConnectionPlan, { ok: true }>, targetId: string): boolean => {
      const state = storeApi.getState();
      if (result.request === null) {
        if (result.binding) state.setInputBinding(targetId, result.binding.input, result.binding.binding);
        return true;
      }
      const outcome = state.connect(result.request, descriptorByType, result.binding ? { binding: result.binding } : undefined);
      if (!outcome.ok) {
        say(outcome.reason, true);
        return false;
      }
      if (result.note) setAnnouncement(result.note);
      return true;
    },
    [storeApi, descriptorByType, say],
  );

  const connect = useCallback(
    (request: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }) => {
      if (readOnly) return;
      const result = plan(request);
      if (result.ok) {
        commitPlan(result, request.target);
        return;
      }
      if (result.coalesce) {
        const coalesce = result.coalesce;
        setAnnouncement(result.reason);
        setOffer({
          reason: result.reason,
          apply: () => {
            const state = storeApi.getState();
            if (coalesce.request === null) {
              state.setInputBinding(request.target, coalesce.input, coalesce.binding);
              return;
            }
            const outcome = state.connect(coalesce.request, descriptorByType, { binding: { input: coalesce.input, binding: coalesce.binding } });
            if (!outcome.ok) say(outcome.reason, true);
          },
        });
        return;
      }
      say(result.reason, true);
    },
    [readOnly, plan, commitPlan, storeApi, descriptorByType, say],
  );

  const isValidConnection = useCallback(
    (request: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }) => {
      const result = plan(request);
      // A fan-in refusal is still a drop the author may complete as "Use first available".
      if (result.ok || result.coalesce) {
        lastRefusal.current = null;
        return true;
      }
      const key = `${request.source}:${request.sourceHandle ?? ''}->${request.target}:${request.targetHandle ?? ''}`;
      if (lastRefusal.current !== key) {
        lastRefusal.current = key;
        setAnnouncement(`Can’t connect: ${result.reason}`);
      }
      return false;
    },
    [plan],
  );

  /** Adds a step (optionally from a preset) and returns its id. */
  const addStep = useCallback(
    (choice: NodePickerChoice, position: { x: number; y: number }): string =>
      storeApi.getState().addNode({ type: choice.descriptor.type, safetyClasses: choice.descriptor.classes }, position, choice.preset ? { config: choice.preset.config } : undefined),
    [storeApi],
  );

  const handlePick = useCallback(
    (choice: NodePickerChoice) => {
      const current = menu;
      setMenu(null);
      if (!current || readOnly) return;
      if (current.kind === 'insert') {
        const state = storeApi.getState();
        const edge = state.edges.find((candidate) => candidate.id === current.edgeId);
        if (!edge) return;
        const source = state.nodes.find((candidate) => candidate.id === edge.source);
        const target = state.nodes.find((candidate) => candidate.id === edge.target);
        const position = source && target ? { x: (source.position.x + target.position.x) / 2, y: (source.position.y + target.position.y) / 2 + 40 } : { x: 0, y: 0 };
        const planner = ({ nodes: draftNodes, edges: draftEdges, newNode }: { nodes: GraphStoreNode[]; edges: typeof state.edges; newNode: GraphStoreNode }): InsertPlan => {
          const draft = { nodes: draftNodes, edges: draftEdges };
          const first = planConnection({ ...draft, descriptorByType, agents, source: edge.source, target: newNode.id, sourceHandle: edge.sourceHandle === 'next' || edge.sourceHandle === 'out' ? null : edge.sourceHandle });
          if (!first.ok || first.request === null) return { error: first.ok ? 'That step cannot follow here.' : first.reason };
          const afterFirst = {
            nodes: first.binding ? draftNodes.map((candidate) => (candidate.id === newNode.id ? { ...candidate, config: { ...candidate.config, inputs: { [first.binding!.input]: first.binding!.binding } } } : candidate)) : draftNodes,
            edges: [...draftEdges, { id: '__planned__', ...first.request }],
          };
          const second = planConnection({ ...afterFirst, descriptorByType, agents, source: newNode.id, target: edge.target, replaceProducer: edge.source });
          if (!second.ok || second.request === null) return { error: second.ok ? 'That step cannot lead into the next one.' : second.reason };
          const bindings = [
            ...(first.binding ? [{ nodeId: newNode.id, input: first.binding.input, binding: first.binding.binding }] : []),
            ...(second.binding ? [{ nodeId: edge.target, input: second.binding.input, binding: second.binding.binding }] : []),
          ];
          return { edges: [first.request, second.request] as ConnectRequest[], bindings };
        };
        const result = state.insertNodeOnEdge(edge.id, { type: choice.descriptor.type, safetyClasses: choice.descriptor.classes }, position, planner, choice.preset ? { config: choice.preset.config } : undefined);
        if (!result.ok) say(result.reason, true);
        return;
      }
      const newId = addStep(choice, current.position);
      if (current.kind === 'connect') {
        const result = plan({ source: current.from.nodeId, sourceHandle: current.from.handleId, target: newId });
        if (result.ok) commitPlan(result, newId);
        else say(result.reason, true);
      }
      storeApi.getState().selectNode(newId);
    },
    [menu, readOnly, storeApi, descriptorByType, agents, addStep, plan, commitPlan, say],
  );

  const handlePaneDrop = useCallback(
    (event: { dataTransfer: DataTransfer | null }, position: { x: number; y: number }) => {
      if (readOnly) return;
      const type = readPaletteDragType(event.dataTransfer);
      const descriptor = type ? descriptorByType.get(type) : undefined;
      if (!descriptor || descriptor.implemented === false) return;
      const preset = presetByKey(readPaletteDragPreset(event.dataTransfer));
      addStep({ descriptor, ...(preset && preset.type === descriptor.type ? { preset } : {}) }, position);
      storeApi.getState().selectNode(null);
    },
    [readOnly, descriptorByType, addStep, storeApi],
  );

  const handleDeleteRequest = useCallback(
    (nodeId: string) => {
      const result = storeApi.getState().deleteNode(nodeId);
      if (!result.ok) say(result.reason, true);
    },
    [storeApi, say],
  );

  const labelOf = useCallback((nodeId: string) => {
    const found = storeApi.getState().nodes.find((candidate) => candidate.id === nodeId);
    return found ? nodeDisplayName(found) : nodeId;
  }, [storeApi]);

  const stepOrder = useMemo(
    () => computeStepOrder(nodes.map((node) => ({ id: node.id, type: node.type })), edges.map((edge) => ({ source: edge.source, target: edge.target }))),
    [nodes, edges],
  );
  const mappings = useMemo(() => edgeMappingLabels(nodes, edges, agents), [nodes, edges, agents]);

  const canvasNodes: WorkflowCanvasNode[] = useMemo(
    () =>
      nodes.map((node) => {
        const entry = stepOrder.get(node.id);
        const io = primaryIoFor(descriptorByType, node.type);
        const ports = canvasPortsOf(node, agents);
        const run = runStates?.get(node.id);
        const missing = inputRows({ node, nodes, edges, agents, promptVariables: [] }).filter((row) => row.status === 'missing');
        const serverFindings = (findings ?? []).filter((finding) => finding.nodeId === node.id);
        const messages = [...serverFindings.map((finding) => finding.message), ...missing.map((row) => `“${row.name}” (${row.type}) is required: choose where it comes from.`)];
        const severity = missing.length > 0 || serverFindings.some((finding) => finding.severity === 'ERROR') ? ('ERROR' as const) : ('WARNING' as const);
        return {
          id: node.id,
          type: node.type,
          label: nodeDisplayName(node),
          position: node.position,
          safetyClasses: node.safetyClasses,
          config: node.config,
          kind: node.type === LOOP_NODE_TYPE ? ('group' as const) : ('node' as const),
          parentId: node.parentId,
          deprecated: descriptorByType.get(node.type)?.deprecated === true,
          hasInput: io.hasInput,
          hasOutput: io.hasOutput,
          branches: branchHandlesFor(descriptorByType, node.type, node.config),
          ...(ports ? { inputPorts: toCanvasPorts(ports.inputs, 'in'), outputPorts: toCanvasPorts(ports.outputs, 'out') } : {}),
          stepNumber: entry && 'step' in entry ? entry.step : null,
          stepMarker: entry && 'marker' in entry ? entry.marker : undefined,
          runState: run?.state,
          runDurationMs: run?.durationMs,
          ...(run?.warnings ? { runWarnings: run.warnings } : {}),
          problem: messages.length > 0 ? { severity, messages } : undefined,
        };
      }),
    [nodes, edges, agents, stepOrder, descriptorByType, runStates, findings],
  );

  /**
   * Wire sockets projected onto the handles the canvas draws: a branch keeps its own handle; a
   * mapped link lands on the typed fields it carries; anything else on the node's first typed
   * port, or the primary dot. React Flow drops an edge whose handle does not exist, so this
   * projection is what keeps every link visible.
   */
  const canvasEdges: WorkflowCanvasEdge[] = useMemo(() => {
    const byId = new Map(canvasNodes.map((node) => [node.id, node]));
    return edges.map((edge) => {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      const mapping = mappings.get(edge.id);
      const isBranch = (source?.branches ?? []).some((branch) => branch.id === edge.sourceHandle);
      const outputs = source?.outputPorts ?? [];
      const inputs = target?.inputPorts ?? [];
      const sourceHandle = isBranch
        ? edge.sourceHandle
        : outputs.length > 0
          ? (outputs.find((port) => port.id === portHandleId('out', mapping?.sourceField ?? ''))?.id ?? outputs[0]?.id)
          : 'out';
      const targetHandle = inputs.length > 0 ? (inputs.find((port) => port.id === portHandleId('in', mapping?.targetField ?? ''))?.id ?? inputs[0]?.id) : 'in';
      const runState = edgeRunStates?.get(edge.id);
      return { id: edge.id, source: edge.source, sourceHandle, target: edge.target, targetHandle, ...(mapping ? { label: mapping.label } : {}), ...(runState ? { runState } : {}) };
    });
  }, [edges, canvasNodes, mappings, edgeRunStates]);

  const openAddMenu = () => {
    const rightmost = nodes.reduce((max, node) => Math.max(max, node.position.x), 0);
    setMenu({ kind: 'add', position: { x: rightmost + 260, y: 120 }, description: 'Add a step to this workflow.' });
  };

  return (
    <div className={className ? `relative h-full min-h-0 ${className}` : 'relative h-full min-h-0'} data-slot="composer-canvas">
      <WorkflowCanvas
        aria-label={ariaLabel}
        nodes={canvasNodes}
        edges={canvasEdges}
        nodeTypes={CORE_NODE_RENDERERS}
        readOnly={readOnly}
        selectedNodeId={selectedNodeId}
        selectedNodeIds={selectedNodeIds}
        selectedEdgeId={selectedEdgeId}
        onSelectionChange={onSelectionChange}
        onSelect={(nodeId) => {
          if (nodeId !== null || storeApi.getState().selectedEdgeId === null) storeApi.getState().selectNode(nodeId);
        }}
        onEdgeSelect={(edgeId) => {
          if (edgeId !== null || storeApi.getState().selectedNodeId === null) storeApi.getState().selectEdge(edgeId);
        }}
        onPaneDrop={handlePaneDrop}
        isValidConnection={isValidConnection}
        onConnect={connect}
        onEdgeInsert={
          readOnly
            ? undefined
            : (edgeId) => {
                const edge = storeApi.getState().edges.find((candidate) => candidate.id === edgeId);
                setMenu({ kind: 'insert', edgeId, description: edge ? `Insert a step between ${labelOf(edge.source)} and ${labelOf(edge.target)}.` : 'Insert a step.' });
              }
        }
        onConnectEndOnPane={readOnly ? undefined : (from, position) => setMenu({ kind: 'connect', from, position, description: `Add a step after ${labelOf(from.nodeId)}.` })}
        onDeleteRequest={handleDeleteRequest}
        onEdgeDelete={(edgeId) => storeApi.getState().disconnectEdge(edgeId)}
        onNodeParentChange={(nodeId, parentId, position) => storeApi.getState().setNodeParent(nodeId, parentId, position)}
        onNodesChange={(next) => {
          // Only a report that actually moves something may touch the store (TASK-890 J5).
          const before = storeApi.getState().nodes;
          const moved = next.some((candidate) => {
            const current = before.find((node) => node.id === candidate.id);
            return current !== undefined && (current.position.x !== candidate.position.x || current.position.y !== candidate.position.y);
          });
          if (!moved) return;
          for (const candidate of next) storeApi.getState().moveNode(candidate.id, candidate.position);
        }}
        fitViewKey={fitViewKey}
        emptyState={emptyState}
      />
      {!readOnly ? (
        <Button type="button" size="sm" variant="secondary" className={`absolute z-10 shadow-raised ${ADD_STEP_PLACEMENT[addStepPlacement]}`} onClick={openAddMenu}>
          <IconPlus aria-hidden="true" />
          Add a step
        </Button>
      ) : null}
      <p role="status" aria-live="polite" className={announcement ? 'bg-background/95 text-foreground absolute right-2 bottom-2 z-10 max-w-sm rounded-md border px-3 py-1.5 text-xs shadow-raised' : 'sr-only'}>
        {announcement}
      </p>
      <NodePickerMenu open={menu !== null} onOpenChange={(open) => !open && setMenu(null)} descriptors={descriptors} onPick={handlePick} description={menu?.description} />
      <AlertDialog open={offer !== null} onOpenChange={(open) => !open && setOffer(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Only one value can arrive</AlertDialogTitle>
            <AlertDialogDescription>
              {offer?.reason} Use the first available instead: the step reads the earlier value, and falls back to the new one when the first has none. To combine
              both, add a Merge step.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                offer?.apply();
                setOffer(null);
              }}
            >
              Use first available
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

