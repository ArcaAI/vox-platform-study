'use client';

/**
 * `WorkflowStudioEditor` (TASK-719 Task 16) — the inner, store-bound editor body. Mounted
 * ONLY once the definition + registry queries have resolved (the outer screen gates on
 * loading/error), so `GraphStoreProvider` hydrates from real data at creation, not empty state.
 *
 * Layout: palette rail (left) — canvas/list (center, `contentMode` follows `viewMode` per rule
 * 11 §1: "never nest a second scroll area inside fill"; the list editor is the one that
 * scrolls) — inspector + validation rail (right). `StudioToolbar` + OCC/tenant banners are the
 * `ScreenTemplate` `header`/`statusBanner`/`toolbar` slots; `StatusFooter` is `footer`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { WorkflowCanvas, type WorkflowCanvasEdge, type WorkflowCanvasNode } from '@arcaai/ui/components/workflow-canvas';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { useAutosave } from '../hooks';
import { publishWorkflowDefinition, validateWorkflowDefinition } from '../api/client';
import { fromWorkflowGraph, toWorkflowGraph } from '../lib/graph-serialization';
import { humanizeKey } from '../lib/schema-form';
import {
  GraphStoreProvider,
  useGraphStore,
  useGraphStoreApi,
  findingsByNodeId,
  selectAutosaveState,
  selectDirty,
  selectEdges,
  selectNodes,
  selectSelectedNode,
  selectSelectedNodeId,
  selectViewMode,
} from '../store';
import type { WorkflowDefinition, WorkflowFinding, WorkflowNodeDescriptor, WorkflowValidationReport } from '../api/types';
import { InspectorPanel } from './inspector';
import { PaletteRail } from './palette';
import { GraphListEditor } from './list-editor';
import { ValidationRail, publishBlockedReason, useFocusNode } from './validation';
import { StudioToolbar } from './studio-toolbar';
import { PublishDialog } from './publish-dialog';

export interface WorkflowStudioEditorProps {
  definition: WorkflowDefinition;
  etag: string | null;
  registryNodes: WorkflowNodeDescriptor[];
}

function EditorBody({ definition, etag, registryNodes }: WorkflowStudioEditorProps) {
  const router = useRouter();
  const storeApi = useGraphStoreApi();
  const nodes = useGraphStore(selectNodes);
  const edges = useGraphStore(selectEdges);
  const dirty = useGraphStore(selectDirty);
  const viewMode = useGraphStore(selectViewMode);
  const selectedNode = useGraphStore(selectSelectedNode);
  const selectedNodeId = useGraphStore(selectSelectedNodeId);
  const autosaveState = useGraphStore(selectAutosaveState);

  const [currentEtag, setCurrentEtag] = useState(etag);
  const [report, setReport] = useState<WorkflowValidationReport | null>(definition.validationReport);
  const [validating, setValidating] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const readOnly = definition.status === 'PUBLISHED' || definition.status === 'DEPRECATED';

  const hydratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (hydratedRef.current === definition.id) return;
    hydratedRef.current = definition.id;
    const { nodes: loadedNodes, edges: loadedEdges } = fromWorkflowGraph(definition.graph);
    const descriptorByType = new Map(registryNodes.map((descriptor) => [descriptor.type, descriptor]));
    storeApi.getState().hydrate(
      loadedNodes.map((node) => ({ ...node, safetyClasses: descriptorByType.get(node.type)?.classes ?? node.safetyClasses })),
      loadedEdges,
    );
  }, [definition.id, definition.graph, registryNodes, storeApi]);

  const autosave = useAutosave({
    definitionId: definition.id,
    getEtag: () => currentEtag,
    onSaved: (saved, nextEtag) => {
      setCurrentEtag(nextEtag);
      storeApi.getState().markSaved(saved.version);
    },
    onStateChange: (state) => storeApi.getState().setAutosaveState(state),
    onMissingPrecondition: () => toast.error('Stale tab — the request went out without If-Match. Refresh the page.'),
  });

  // Debounced graph-shape autosave — README §7 honesty note: only `graph` autosaves in this
  // pass; name/description edits are not wired to a form yet (Task 16 was reached, but the
  // metadata-only settings panel was not built this session — see the ticket README). The
  // hook's own debounce coalesces rapid re-schedules, so re-firing on every `nodes`/`edges`
  // change while `dirty` is exactly the intended path, not redundant work.
  useEffect(() => {
    if (readOnly || !dirty) return;
    autosave.schedule({ graph: toWorkflowGraph(nodes, edges) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `autosave.schedule` is a stable useCallback; including it would not change behavior
  }, [nodes, edges, dirty, readOnly]);

  const focusNode = useFocusNode({ viewMode, onSelect: (nodeId) => storeApi.getState().selectNode(nodeId) });
  const problemsByNodeId = useMemo(() => findingsByNodeId(report?.findings ?? []), [report]);

  async function handleValidate() {
    setValidating(true);
    try {
      const updated = await validateWorkflowDefinition(definition.id);
      setReport(updated.validationReport);
      toast[updated.validationReport?.ok ? 'success' : 'error'](updated.validationReport?.ok ? 'Validation passed.' : 'Validation found problems — see the rail.');
    } catch {
      toast.error('Validate failed.');
    } finally {
      setValidating(false);
    }
  }

  async function handlePublish(activate: boolean) {
    setPublishing(true);
    try {
      await publishWorkflowDefinition(definition.id, { activate });
      toast.success('Published.');
      setPublishOpen(false);
      router.refresh();
    } catch {
      toast.error('Publish failed.');
    } finally {
      setPublishing(false);
    }
  }

  const canvasNodes: WorkflowCanvasNode[] = nodes.map((node) => ({
    id: node.id,
    type: node.type,
    label: humanizeKey(node.type),
    position: node.position,
    safetyClasses: node.safetyClasses,
    config: node.config,
    problem: (() => {
      const findings = problemsByNodeId.get(node.id);
      if (!findings || findings.length === 0) return undefined;
      return { severity: findings.some((f: WorkflowFinding) => f.severity === 'ERROR') ? ('ERROR' as const) : ('WARNING' as const), messages: findings.map((f: WorkflowFinding) => f.message) };
    })(),
  }));
  const canvasEdges: WorkflowCanvasEdge[] = edges.map((edge) => ({ id: edge.id, source: edge.source, sourceHandle: edge.sourceHandle, target: edge.target, targetHandle: edge.targetHandle }));

  return (
    <ScreenTemplate
      contentMode={viewMode === 'list' ? 'scroll' : 'fill'}
      header={<PageHeader title={definition.name} meta={<span className="font-mono text-xs">{definition.slug} · v{definition.versionNumber} · {definition.status}</span>} />}
      statusBanner={
        <>
          {autosave.paused ? <OccConflictAlert error={autosave.lastError} onReload={() => router.refresh()} onOverwrite={() => autosave.resume()} /> : null}
          {readOnly ? (
            <p role="status" className="text-muted-foreground text-sm">
              This version is {definition.status.toLowerCase()} and read-only. Create a new version to keep editing.
            </p>
          ) : null}
        </>
      }
      toolbar={
        <StudioToolbar
          viewMode={viewMode}
          onViewModeChange={(mode) => storeApi.getState().setViewMode(mode)}
          autosaveState={autosaveState}
          onValidate={() => void handleValidate()}
          validating={validating}
          onPublish={() => setPublishOpen(true)}
          publishDisabledReason={readOnly ? 'This version is already published.' : publishBlockedReason(report)}
          publishing={publishing}
          readOnly={readOnly}
        />
      }
      footer={
        <StatusFooter
          start={<span>{dirty ? 'Unsaved changes — autosaving…' : 'All changes saved.'}</span>}
          end={
            <span aria-hidden className="font-mono">
              PATCH /admin/workflow-definitions/{definition.id}
            </span>
          }
        />
      }
    >
      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr_320px] gap-4">
        <aside className="min-h-0 overflow-y-auto" aria-label="Node palette panel">
          <PaletteRail
            descriptors={registryNodes}
            onAddNode={(descriptor) =>
              storeApi.getState().addNode({ type: descriptor.type, safetyClasses: descriptor.classes }, { x: 120, y: 120 + nodes.length * 100 })
            }
          />
        </aside>
        <div className="min-h-0 flex-1">
          {viewMode === 'canvas' ? (
            <WorkflowCanvas
              aria-label={`${definition.name} graph, canvas view`}
              nodes={canvasNodes}
              edges={canvasEdges}
              readOnly={readOnly}
              selectedNodeId={selectedNodeId}
              onSelect={(nodeId) => storeApi.getState().selectNode(nodeId)}
              onDeleteRequest={(nodeId) => {
                const result = storeApi.getState().deleteNode(nodeId);
                if (!result.ok) toast.error(result.reason);
              }}
              onConnect={(connection) => {
                const result = storeApi.getState().connect({
                  source: connection.source,
                  sourceHandle: connection.sourceHandle ?? 'out',
                  target: connection.target,
                  targetHandle: connection.targetHandle ?? 'in',
                });
                if (!result.ok) toast.error(result.reason);
              }}
              onNodesChange={(next) => {
                for (const node of next) storeApi.getState().moveNode(node.id, node.position);
              }}
            />
          ) : (
            <GraphListEditor
              nodes={nodes}
              edges={edges}
              selectedNodeId={selectedNodeId}
              problemsByNodeId={problemsByNodeId}
              readOnly={readOnly}
              onSelect={(nodeId) => storeApi.getState().selectNode(nodeId)}
              onDeleteRequest={(nodeId) => {
                const result = storeApi.getState().deleteNode(nodeId);
                if (!result.ok) toast.error(result.reason);
                return result;
              }}
              onMove={(nodeId, direction) => storeApi.getState().reorderNode(nodeId, direction)}
              onConnect={(source, target) => {
                const result = storeApi.getState().connect({ source, sourceHandle: 'out', target, targetHandle: 'in' });
                if (!result.ok) toast.error(result.reason);
                return result;
              }}
              onDisconnect={(edgeId) => storeApi.getState().disconnectEdge(edgeId)}
            />
          )}
        </div>
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto" aria-label="Inspector and validation panel">
          <InspectorPanel
            node={selectedNode}
            configSchema={undefined}
            problems={selectedNode ? (problemsByNodeId.get(selectedNode.id) ?? []) : []}
            onConfigChange={(config) => selectedNode && storeApi.getState().updateNodeConfig(selectedNode.id, config)}
            readOnly={readOnly}
          />
          <ValidationRail report={report} nodes={nodes} onActivate={(finding) => finding.nodeId && focusNode(finding.nodeId)} />
        </aside>
      </div>
      <PublishDialog open={publishOpen} onOpenChange={setPublishOpen} onConfirm={(activate) => void handlePublish(activate)} confirming={publishing} />
    </ScreenTemplate>
  );
}

export function WorkflowStudioEditor(props: WorkflowStudioEditorProps) {
  return (
    <GraphStoreProvider>
      <EditorBody {...props} />
    </GraphStoreProvider>
  );
}
