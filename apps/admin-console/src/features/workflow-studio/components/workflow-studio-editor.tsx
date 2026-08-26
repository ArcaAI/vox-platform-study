'use client';

/**
 * `WorkflowStudioEditor` (TASK-719 Task 16) — the inner, store-bound editor body. Mounted
 * ONLY once the definition + registry queries have resolved (the outer screen gates on
 * loading/error), so `GraphStoreProvider` hydrates from real data at creation, not empty state.
 *
 * Layout: palette rail (left) — canvas/list (center) — inspector + validation rail (right).
 * `StudioToolbar` + OCC/tenant banners are the `ScreenTemplate` `header`/`statusBanner`/
 * `toolbar` slots; `StatusFooter` is `footer`.
 *
 * REFLOW (WCAG 1.4.10, fixed 2026-08-19): the frame runs `contentMode="scroll"` in BOTH view
 * modes, and the three-panel row only exists at `EDITOR_WIDE` — at least 64rem wide AND 32rem
 * tall. Below either threshold the panels stack into one column with intrinsic heights and the
 * ScreenTemplate's own content region scrolls, which is what makes the editor usable at 200 %
 * zoom (640×400 CSS px), where the previous fixed-height flex row squeezed palette and canvas
 * to ~59 px. The wide branch adds `h-full` + per-panel `overflow-y-auto`, so exactly one scroll
 * container is active per panel in either branch — never nested (rule 11 §1).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Button, Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@arcaai/ui';
import { IconPencil, IconPlus, IconTopologyStar3 } from '@tabler/icons-react';
import { WorkflowCanvas, type WorkflowCanvasEdge, type WorkflowCanvasNode } from '@arcaai/ui/components/workflow-canvas';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { useAutosave, useStudioShortcuts, useUnsavedChangesGuard } from '../hooks';
import { useCreateWorkflowDefinition } from '../api';
import { publishWorkflowDefinition, validateWorkflowDefinition } from '../api/client';
import { fromWorkflowGraph, toWorkflowGraph } from '../lib/graph-serialization';
import { humanizeKey } from '../lib/schema-form';
import {
  GraphStoreProvider,
  useGraphStore,
  useGraphStoreApi,
  findingsByNodeId,
  selectAutosaveState,
  selectCanRedo,
  selectCanUndo,
  selectDirty,
  selectEdges,
  selectNodes,
  selectSelectedNode,
  selectSelectedNodeId,
  selectViewMode,
} from '../store';
import type { WorkflowStudioViewMode } from '../store/types';
import type { WorkflowDefinition, WorkflowFinding, WorkflowNodeDescriptor, WorkflowValidationReport } from '../api/types';
import { InspectorPanel } from './inspector';
import { PaletteRail } from './palette';
import { GraphListEditor } from './list-editor';
import { ValidationRail, publishBlockedReason, useFocusNode } from './validation';
import { StudioToolbar } from './studio-toolbar';
import { PublishDialog } from './publish-dialog';
import { DefinitionMetadataForm } from './definition-metadata-form';

const VIEW_MODES = ['canvas', 'list'] as const satisfies readonly WorkflowStudioViewMode[];

/**
 * The three-panel layout is gated on `[@media(min-width:64rem)_and_(min-height:32rem)]` below.
 * A width breakpoint alone is not enough: 200 % zoom on a 1280×800 desktop yields 640×400 CSS
 * px, but a wide-and-short window (e.g. 1440×420) squeezes the same three panels just as badly,
 * so the height is part of the condition. The variant is written out literally at each use —
 * Tailwind v4 scans source TEXT for candidates, so a class assembled from a constant would
 * never be generated.
 */

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
  const canUndo = useGraphStore(selectCanUndo);
  const canRedo = useGraphStore(selectCanRedo);

  const [currentEtag, setCurrentEtag] = useState(etag);
  const [report, setReport] = useState<WorkflowValidationReport | null>(definition.validationReport);
  const [validating, setValidating] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [name, setName] = useState(definition.name);
  const [description, setDescription] = useState(definition.description ?? '');
  const [metadataDirty, setMetadataDirty] = useState(false);
  const readOnly = definition.status === 'PUBLISHED' || definition.status === 'DEPRECATED';
  const createNewVersion = useCreateWorkflowDefinition();

  // Keyed once per registry fetch, not per hydrate — the inspector needs it live for whichever
  // node is currently selected, not just at hydration time.
  const descriptorByType = useMemo(() => new Map(registryNodes.map((descriptor) => [descriptor.type, descriptor])), [registryNodes]);
  const selectedNodeConfigSchema = selectedNode ? (descriptorByType.get(selectedNode.type)?.configSchema ?? undefined) : undefined;

  const hydratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (hydratedRef.current === definition.id) return;
    hydratedRef.current = definition.id;
    const { nodes: loadedNodes, edges: loadedEdges } = fromWorkflowGraph(definition.graph);
    storeApi.getState().hydrate(
      loadedNodes.map((node) => ({ ...node, safetyClasses: descriptorByType.get(node.type)?.classes ?? node.safetyClasses })),
      loadedEdges,
    );
    setName(definition.name);
    setDescription(definition.description ?? '');
    setMetadataDirty(false);
  }, [definition.id, definition.graph, definition.name, definition.description, descriptorByType, storeApi]);

  const autosave = useAutosave({
    definitionId: definition.id,
    getEtag: () => currentEtag,
    onSaved: (saved, nextEtag) => {
      setCurrentEtag(nextEtag);
      storeApi.getState().markSaved(saved.version);
      setMetadataDirty(false);
    },
    onStateChange: (state) => storeApi.getState().setAutosaveState(state),
    onMissingPrecondition: () => toast.error('Stale tab — the request went out without If-Match. Refresh the page.'),
  });

  // Debounced graph-shape autosave. The hook's own debounce coalesces rapid re-schedules, so
  // re-firing on every `nodes`/`edges` change while `dirty` is exactly the intended path, not
  // redundant work.
  useEffect(() => {
    if (readOnly || !dirty) return;
    autosave.schedule({ graph: toWorkflowGraph(nodes, edges) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `autosave.schedule` is a stable useCallback; including it would not change behavior
  }, [nodes, edges, dirty, readOnly]);

  // Name/description autosave — same debounced `schedule()` the graph uses (merges into the
  // same in-flight patch), driven by `DefinitionMetadataForm`'s controlled fields.
  function handleNameChange(next: string) {
    setName(next);
    setMetadataDirty(true);
    if (!readOnly) autosave.schedule({ name: next });
  }
  function handleDescriptionChange(next: string) {
    setDescription(next);
    setMetadataDirty(true);
    if (!readOnly) autosave.schedule({ description: next });
  }

  // Unsaved-changes guard (design.md §Data flow) — combines the store's graph-shape `dirty` with
  // the local metadata-form `dirty` flag; a read-only (published) row is never dirty.
  useUnsavedChangesGuard(!readOnly && (dirty || metadataDirty));

  // `?view=` URL sync (Task 16 remainder) — the URL is the shareable source of truth; the store
  // stays the single graph-editing state per rule 08 §Store, kept in lockstep both ways so a
  // shared link (`?view=list`) and the toolbar toggle agree.
  const [urlView, setUrlView] = useQueryState('view', parseAsStringLiteral(VIEW_MODES).withDefault('canvas'));
  useEffect(() => {
    if (urlView !== viewMode) storeApi.getState().setViewMode(urlView);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-sync when the URL param itself changes (e.g. back/forward, shared link)
  }, [urlView]);
  function handleViewModeChange(mode: WorkflowStudioViewMode) {
    storeApi.getState().setViewMode(mode);
    void setUrlView(mode);
  }

  // "Create new version from this" (design.md §Plane 1: "published rows immutable — edits create
  // versions") — a PUBLISHED/DEPRECATED row offers no edit affordance; this is the branch action
  // instead. Clones the frozen graph into a fresh DRAFT in the same (tenantId, slug) lineage.
  async function handleCreateNewVersion() {
    try {
      const created = await createNewVersion.mutateAsync({
        slug: definition.slug,
        name: definition.name,
        description: definition.description ?? undefined,
        paletteKey: definition.paletteKey,
        graph: definition.graph,
        parentVersionId: definition.id,
      });
      toast.success('New draft version created.');
      router.push(`/workflow-studio/${created.id}`);
    } catch {
      toast.error('Could not create a new version.');
    }
  }

  // Stable identity is load-bearing for the canvas: `WorkflowCanvas` memoizes its
  // `onSelectionChange` on this callback, and React Flow re-emits the current selection every
  // time that handler's identity changes — an inline arrow here looped selection into
  // "Maximum update depth exceeded".
  const selectNodeById = useCallback((nodeId: string | null) => storeApi.getState().selectNode(nodeId), [storeApi]);
  const focusNode = useFocusNode({ viewMode, onSelect: selectNodeById });

  const handleUndo = useCallback(() => storeApi.getState().undo(), [storeApi]);
  const handleRedo = useCallback(() => storeApi.getState().redo(), [storeApi]);
  const handleDuplicate = useCallback(
    (nodeId: string | null) => {
      if (!nodeId) return;
      const result = storeApi.getState().duplicateNode(nodeId);
      if (!result.ok) toast.error(result.reason);
    },
    [storeApi],
  );
  const duplicateSelected = useCallback(() => handleDuplicate(storeApi.getState().selectedNodeId), [handleDuplicate, storeApi]);
  // Drag-time guard: the SAME store predicate (`canConnect`, port-lattice check included via
  // `descriptorByType`) the committed `connect` below runs, so drag-time and commit-time can
  // never disagree (`@arcaai/ui`'s `workflow-canvas/types.ts:64-69`). React Flow refuses an
  // invalid drop target visually, but a color change alone doesn't say WHY — so this also
  // toasts the store's reason (e.g. "`document` cannot feed an input expecting `transcript`."),
  // deduped per attempted (source, target) pair so hovering the same invalid handle doesn't
  // spam the user while the pointer is still moving (11-ux-ui-principles.md §5: feedback within
  // 100ms, never silent, but not noisy either).
  const lastRefusedConnectionRef = useRef<string | null>(null);
  const isValidConnection = useCallback(
    (connection: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }) => {
      const request = {
        source: connection.source,
        sourceHandle: connection.sourceHandle ?? 'out',
        target: connection.target,
        targetHandle: connection.targetHandle ?? 'in',
      };
      const result = storeApi.getState().canConnect(request, descriptorByType);
      if (result.ok) {
        lastRefusedConnectionRef.current = null;
        return true;
      }
      const key = `${request.source}:${request.sourceHandle}->${request.target}:${request.targetHandle}`;
      if (lastRefusedConnectionRef.current !== key) {
        lastRefusedConnectionRef.current = key;
        toast.error(result.reason);
      }
      return false;
    },
    [storeApi, descriptorByType],
  );

  useStudioShortcuts({ enabled: !readOnly, onUndo: handleUndo, onRedo: handleRedo, onDuplicate: duplicateSelected });
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

  const findings = report?.findings ?? [];
  const errorCount = findings.filter((finding) => finding.severity === 'ERROR').length;
  const warningCount = findings.filter((finding) => finding.severity === 'WARNING').length;

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
      contentMode="scroll"
      header={
        <PageHeader
          title={name}
          meta={<span className="font-mono text-xs">{definition.slug} · v{definition.versionNumber} · {definition.status}</span>}
          actions={
            <Button type="button" variant="outline" size="sm" onClick={() => setMetadataOpen(true)}>
              <IconPencil aria-hidden />
              Edit details
            </Button>
          }
        />
      }
      statusBanner={
        <>
          {autosave.paused ? <OccConflictAlert error={autosave.lastError} onReload={() => router.refresh()} onOverwrite={() => autosave.resume()} /> : null}
          {readOnly ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p role="status" className="text-muted-foreground text-sm">
                This version is {definition.status.toLowerCase()} and read-only. Create a new version to keep editing.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void handleCreateNewVersion()} disabled={createNewVersion.isPending}>
                <IconPlus aria-hidden />
                {createNewVersion.isPending ? 'Creating…' : 'Create new version'}
              </Button>
            </div>
          ) : null}
        </>
      }
      toolbar={
        <StudioToolbar
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
          autosaveState={autosaveState}
          onValidate={() => void handleValidate()}
          validating={validating}
          onPublish={() => setPublishOpen(true)}
          publishDisabledReason={readOnly ? 'This version is already published.' : publishBlockedReason(report)}
          publishing={publishing}
          readOnly={readOnly}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={handleUndo}
          onRedo={handleRedo}
          sandboxDefinitionId={definition.id}
        />
      }
      footer={
        <StatusFooter
          start={
            <>
              <span>{dirty ? 'Unsaved changes — autosaving…' : 'All changes saved.'}</span>
              <span>
                {nodes.length} node{nodes.length === 1 ? '' : 's'} · {edges.length} connection{edges.length === 1 ? '' : 's'}
              </span>
              <span className={errorCount > 0 ? 'text-destructive' : undefined}>
                {report ? `${errorCount} error${errorCount === 1 ? '' : 's'}, ${warningCount} warning${warningCount === 1 ? '' : 's'}` : 'Not yet validated'}
              </span>
            </>
          }
          end={
            <span aria-hidden className="font-mono">
              PATCH /admin/workflow-definitions/{definition.id}
            </span>
          }
        />
      }
    >
      <div className="grid min-h-0 grid-cols-1 gap-4 [@media(min-width:64rem)_and_(min-height:32rem)]:h-full [@media(min-width:64rem)_and_(min-height:32rem)]:grid-cols-[240px_1fr_320px]">
        <aside className="min-h-0 [@media(min-width:64rem)_and_(min-height:32rem)]:overflow-y-auto" aria-label="Node palette panel">
          <PaletteRail
            descriptors={registryNodes}
            onAddNode={(descriptor) =>
              storeApi.getState().addNode({ type: descriptor.type, safetyClasses: descriptor.classes }, { x: 120, y: 120 + nodes.length * 100 })
            }
          />
        </aside>
        <div className="min-h-[26rem] [@media(min-width:64rem)_and_(min-height:32rem)]:min-h-0">
          {viewMode === 'canvas' ? (
            <WorkflowCanvas
              aria-label={`${name} graph, canvas view`}
              nodes={canvasNodes}
              edges={canvasEdges}
              readOnly={readOnly}
              selectedNodeId={selectedNodeId}
              onSelect={selectNodeById}
              isValidConnection={isValidConnection}
              emptyState={
                <Empty>
                  <EmptyMedia variant="icon">
                    <IconTopologyStar3 aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No nodes yet</EmptyTitle>
                  <EmptyDescription>Add a node from the palette on the left, or switch to the list view for a pointer-free path.</EmptyDescription>
                </Empty>
              }
              onDeleteRequest={(nodeId) => {
                const result = storeApi.getState().deleteNode(nodeId);
                if (!result.ok) toast.error(result.reason);
              }}
              onConnect={(connection) => {
                const result = storeApi.getState().connect(
                  {
                    source: connection.source,
                    sourceHandle: connection.sourceHandle ?? 'out',
                    target: connection.target,
                    targetHandle: connection.targetHandle ?? 'in',
                  },
                  descriptorByType,
                );
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
              onSelect={selectNodeById}
              onDeleteRequest={(nodeId) => {
                const result = storeApi.getState().deleteNode(nodeId);
                if (!result.ok) toast.error(result.reason);
                return result;
              }}
              onMove={(nodeId, direction) => storeApi.getState().reorderNode(nodeId, direction)}
              onDuplicate={handleDuplicate}
              onConnect={(source, target) => {
                const result = storeApi.getState().connect({ source, sourceHandle: 'out', target, targetHandle: 'in' }, descriptorByType);
                if (!result.ok) toast.error(result.reason);
                return result;
              }}
              onDisconnect={(edgeId) => storeApi.getState().disconnectEdge(edgeId)}
            />
          )}
        </div>
        <aside className="flex min-h-0 flex-col gap-4 [@media(min-width:64rem)_and_(min-height:32rem)]:overflow-y-auto" aria-label="Inspector and validation panel">
          <InspectorPanel
            node={selectedNode}
            configSchema={selectedNodeConfigSchema}
            problems={selectedNode ? (problemsByNodeId.get(selectedNode.id) ?? []) : []}
            onConfigChange={(config) => selectedNode && storeApi.getState().updateNodeConfig(selectedNode.id, config)}
            readOnly={readOnly}
          />
          <ValidationRail report={report} nodes={nodes} onActivate={(finding) => finding.nodeId && focusNode(finding.nodeId)} />
        </aside>
      </div>
      <PublishDialog open={publishOpen} onOpenChange={setPublishOpen} onConfirm={(activate) => void handlePublish(activate)} confirming={publishing} />
      <DefinitionMetadataForm
        open={metadataOpen}
        onOpenChange={setMetadataOpen}
        name={name}
        description={description}
        onNameChange={handleNameChange}
        onDescriptionChange={handleDescriptionChange}
        readOnly={readOnly}
      />
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
