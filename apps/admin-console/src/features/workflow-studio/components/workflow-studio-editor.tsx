'use client';

/**
 * `WorkflowStudioEditor` — the one Workflow Studio (TASK-893 OD-1/OD-3). Mounted ONLY once the
 * definition + registry queries have resolved (the outer screen gates on loading/error), so
 * `GraphStoreProvider` hydrates from real data at creation, not empty state.
 *
 * SHELL (TASK-1036 §3.6, wave C lane C2a). A `StudioHeader` (inline rename, slug + copy, lifecycle
 * badge, version count → history sheet, Pins, Settings, Validate, Publish) over the Composer ·
 * Test · Integration tabs, whose state lives in the URL (`?tab=`). The Composer is canvas-first:
 * the canvas fills the content region and the node palette (snapped left) and the inspector
 * (snapped right, only once a node is selected or Problems is opened) are `FloatingPane`s over it —
 * movable, resizable and collapsible by pointer or keyboard (OD-17, WCAG 2.5.7), stacked as plain
 * sections below `md`. The Test and Integration tabs are other lanes' components, mounted here with
 * the definition id; each stays mounted (hidden) once visited so a live run survives a tab switch.
 *
 * COMPOSER GLUE (TASK-1036 lane C2c). The canvas is `ComposerCanvas` (lane C2b), which owns every
 * canvas gesture against the store — typed ports, auto-mapped links, `+` on a link, drop, delete —
 * so the editor no longer carries its own connect / drop / secondary-binding code. `graph.settings`
 * travels with the graph on every hydrate, Save and export. Selecting a LINK opens the inspector
 * (its edge view), and the inspector reads the Test tab's last run per node (`useNodeLastRuns`).
 *
 * SAVE MODEL (OD-7). No autosave. Every edit — including a node MOVE and a header rename — marks
 * the store dirty and waits for the admin to press Save, which performs the same If-Match PATCH
 * autosave used to (428 on a missing precondition, 412 -> `OccConflictAlert`). Discard reverts to
 * the last saved graph. `useUnsavedChangesGuard` is therefore load-bearing, not a backstop.
 *
 * READ-ONLY IS A STATE, NOT A SILENCE (§3.8). A PUBLISHED/DEPRECATED version disabled every canvas
 * gesture behind one `readOnly` flag while the only explanation was a line of muted text — which
 * is exactly how "cannot move / delete / link / drop any node" was reported against 11 of the 12
 * seeded definitions. It now renders a lock chip in the header, a prominent banner, an `inert`
 * palette and a primary "Edit as new draft". `handleAddNode` carries the SAME `readOnly` gate the
 * drop path has: before this, a palette CLICK mutated the store on a published row and the drop
 * path refused, so the two paths disagreed about the same rule.
 *
 * PUBLISH IS GATED ON THE SERVER REPORT. `publishBlockedReason(report)` reads the report the
 * gateway stored (adopted from validate / save / publish responses), never a client validator, and
 * a dirty buffer withholds it too — publish freezes the SAVED definition.
 *
 * REFLOW (WCAG 1.4.10): below `md` the Composer is one scrolling column — palette, canvas,
 * inspector as stacked sections; at `md` and up the panes float. One scroll container is active
 * per panel in either branch — never nested (rule 11 §1).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@arcaai/ui';
import { IconDots, IconLock, IconPencil, IconPlus, IconTopologyStar3 } from '@tabler/icons-react';
import { ACTION_CATALOGUE } from '@arcaai/workflow-contract';
import { layoutWorkflowGraph } from '@arcaai/ui/components/workflow-canvas';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { GatewayError } from '@/shared/api';
import { FloatingPane } from '@/shared/floating-pane';
import { useStudioShortcuts, useUnsavedChangesGuard } from '../hooks';
import { useSaveModel, type SaveDefinitionPatch } from '../hooks/use-save-model';
import {
  useCloneWorkflowDefinition,
  useCreateDraftFrom,
  useExportWorkflowDefinition,
  useImportWorkflowDefinition,
  usePublishWorkflowDefinition,
  useValidateWorkflowDefinition,
  useWorkflowDefinitionVersions,
  useWorkflowTemplates,
} from '../api';
import { getWorkflowDefinition } from '../api/client';
import { workflowStudioKeys } from '../api/keys';
import { confirmLeave } from '../hooks/use-unsaved-changes-guard';
import { CORE_PALETTE_KEY } from '../lib/palette-keys';
import { fromWorkflowGraph, toWorkflowGraph } from '../lib/graph-serialization';
import { layoutClusteredGraph } from '../lib/ensure-canvas-layout';
import { GRAPH_EXPORT_FILENAME, exportGraphJson, parseGraphJson } from '../lib/graph-io';
import { BUNDLE_EXPORT_FILENAME, downloadJson } from '../lib/bundle-io';
import { readContextSchemaBinding } from '../lib/context-schema-ref';
import { actionKeyOf } from '../lib/core-ports';
import { nodeDisplayName } from '../lib/node-identity';
import { humanizeKey } from '../lib/schema-form';
import { planConnection } from '../lib/connection-plan';
import { computeStepOrder } from '../lib/step-order';
import {
  GraphStoreProvider,
  useGraphStore,
  useGraphStoreApi,
  findingsByNodeId,
  selectCanDiscard,
  selectCanRedo,
  selectCanSave,
  selectCanUndo,
  selectDirty,
  selectEdges,
  selectNodes,
  selectSaveState,
  selectSelectedEdgeId,
  selectSelectedNode,
  selectSelectedNodeId,
} from '../store';
import type { WorkflowDefinition, WorkflowNodeDescriptor, WorkflowValidationReport } from '../api/types';
import { InspectorPanel, type InspectorTab } from './inspector';
import { ComposerCanvas, runOverlayFromLastRuns, useComposerAgents } from './canvas';
import { PromptBindingsRail } from './prompt-bindings';
import { PaletteRail } from './palette';
import { ValidationRail, publishBlockedReason, useFocusNode } from './validation';
import { StudioToolbar, type StudioNodeCommands } from './studio-toolbar';
import { PublishDialog } from './publish-dialog';
import { DefinitionMetadataForm } from './definition-metadata-form';
import { CloneDefinitionDialog, type CloneDefinitionSubmission } from './clone-definition-dialog';
import { ImportDefinitionDialog, type ImportDefinitionSubmission } from './import-definition-dialog';
import { WorkflowSwitcher } from './workflow-switcher';
import { StudioHeader, collectAgentPins } from './header';
import { TestTab, useNodeLastRuns } from './test-tab';
import { IntegrationTab } from './integration-tab';
import { VersionHistorySheet } from './management/version-history-sheet';
import { SettingsDialog } from './settings/settings-dialog';

/** The one container node type: its body is the set of nodes naming it as `parentId` (TASK-864). */
const LOOP_NODE_TYPE = 'core.loop';
const ACTION_NODE_TYPE = 'core.action';

/** The studio's tabs. The URL carries the choice (`?tab=`), so a refresh and a shared link land on the same one. */
const STUDIO_TABS = ['composer', 'test', 'integration'] as const;
type StudioTab = (typeof STUDIO_TABS)[number];

/**
 * A tab panel: a fixed-height flex column that hides (not unmounts) when inactive. Radix does not
 * set `hidden` on a force-mounted panel, and `flex` would defeat the attribute anyway, so each
 * panel passes `hidden` AND carries the `data-[state=inactive]:hidden` class.
 */
const TAB_PANEL_CLASS = 'flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden';

/** Run-context references the CEL editor offers: the trigger, every declared variable, every node. */
function celReferencesOf(nodes: ReadonlyArray<{ id: string; type: string; config: Record<string, unknown> }>): string[] {
  const vars = nodes
    .filter((node) => node.type === 'core.variable')
    .flatMap((node) => (Array.isArray(node.config.variables) ? node.config.variables : []))
    .map((variable) => (variable && typeof variable === 'object' ? (variable as { key?: unknown }).key : undefined))
    .filter((key): key is string => typeof key === 'string' && key.length > 0)
    .map((key) => `vars.${key}`);
  return ['trigger', ...vars, ...nodes.map((node) => `nodes.${node.id}`)];
}

function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export interface WorkflowStudioEditorProps {
  definition: WorkflowDefinition;
  etag: string | null;
  registryNodes: WorkflowNodeDescriptor[];
}

/** The strong ETag a versioned row implies, for a response that arrived without the header. */
function etagOf(row: { version?: number | null }): string | null {
  return typeof row.version === 'number' && row.version > 0 ? `"${row.version}"` : null;
}

/**
 * TASK-965 WS-1 (WF-6) — a refused publish is the gateway's most actionable answer (the publish
 * gate, a capability refusal, "is PUBLISHED and can no longer be edited"); it is shown verbatim,
 * with the first finding when the body carries one, never reduced to "Publish failed."
 */
function lifecycleFailureMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof GatewayError)) return fallback;
  const findings = (cause.details as { findings?: { message?: string }[] } | undefined)?.findings;
  const first = findings?.find((finding) => typeof finding?.message === 'string')?.message;
  return first ? `${cause.message} ${first}` : cause.message;
}

function EditorBody({ definition, etag, registryNodes }: WorkflowStudioEditorProps) {
  const router = useRouter();
  const storeApi = useGraphStoreApi();
  const nodes = useGraphStore(selectNodes);
  const edges = useGraphStore(selectEdges);
  const dirty = useGraphStore(selectDirty);
  const selectedNode = useGraphStore(selectSelectedNode);
  const selectedNodeId = useGraphStore(selectSelectedNodeId);
  const selectedEdgeId = useGraphStore(selectSelectedEdgeId);
  const saveState = useGraphStore(selectSaveState);
  const storeCanSave = useGraphStore(selectCanSave);
  const storeCanDiscard = useGraphStore(selectCanDiscard);
  const canUndo = useGraphStore(selectCanUndo);
  const canRedo = useGraphStore(selectCanRedo);

  /**
   * The canvas's FULL selection (OD-5: "the loop must be able to wrap one or many node").
   * `selectedNodeId` in the store stays the PRIMARY — it drives the inspector, which shows one
   * node — while this drives the multi-node commands. Held here rather than in the graph store
   * because it is viewport state, not authored graph data: box-selecting three nodes changes
   * nothing about the workflow and must never mark it dirty.
   */
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  // TASK-965 WS-1 — the ETag FOLLOWS the prop (an out-of-band refetch — a node prompt edit, the
  // publish invalidation — must never leave a stale If-Match behind, WF-11) and is ALSO adopted
  // from the validate/publish/save responses (WF-2, WF-10). Adjusted during render, not in an
  // effect: the compiler lint forbids `setState` in an effect body, and a render-time adjustment
  // is what React itself prescribes for "state that derives from a prop change".
  const [currentEtag, setCurrentEtag] = useState(etag);
  const [seenEtag, setSeenEtag] = useState(etag);
  if (etag !== seenEtag) {
    setSeenEtag(etag);
    setCurrentEtag(etag);
  }
  // Lifecycle status follows the prop the same way, and is adopted from the validate/publish
  // responses so the editor locks the moment the gateway says PUBLISHED — not after the next
  // refetch (WF-1).
  const [status, setStatus] = useState(definition.status);
  const [seenStatus, setSeenStatus] = useState(definition.status);
  if (definition.status !== seenStatus) {
    setSeenStatus(definition.status);
    setStatus(definition.status);
  }
  const [report, setReport] = useState<WorkflowValidationReport | null>(definition.validationReport);
  const [validating, setValidating] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // TASK-890 §3.10 — once a publish succeeds, the SAME dialog swaps to the endpoints panel
  // instead of closing; reset the moment the dialog is dismissed so re-opening it for the NEXT
  // publish starts back on the confirm step.
  const [justPublished, setJustPublished] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  /** Bumped after a layout pass so the canvas re-fits; `fitView` on mount would otherwise stay zoomed into the origin pile. */
  const [fitViewKey, setFitViewKey] = useState(0);
  const [name, setName] = useState(definition.name);
  const [description, setDescription] = useState(definition.description ?? '');
  const [metadataDirty, setMetadataDirty] = useState(false);
  const [tab, setTab] = useQueryState('tab', parseAsStringLiteral(STUDIO_TABS).withDefault('composer'));
  // Test and Integration mount on first visit and then stay mounted (hidden): a live run or a
  // half-read guide must survive a trip back to the Composer. Adjusted during render — the compiler
  // lint forbids `setState` in an effect body.
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<StudioTab>>(() => new Set<StudioTab>([tab]));
  if (!visitedTabs.has(tab)) setVisitedTabs(new Set([...visitedTabs, tab]));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('config');
  /**
   * The right rail collapses "entirely when no node is selected" so the canvas gains the width
   * (§3.5). But Problems is GRAPH-level, not node-level — collapsing on deselect alone would make
   * it unreachable with nothing selected. So the rail is open when a node OR A LINK is selected
   * (TASK-1036 C2c: the edge inspector — what a link carries, and its delete — lives in the
   * inspector) OR the admin explicitly opened it for Problems; closing it clears all three.
   */
  const [railPinned, setRailPinned] = useState(false);
  const railOpen = selectedNodeId !== null || selectedEdgeId !== null || railPinned;
  const versionsQuery = useWorkflowDefinitionVersions(definition.id);
  const versionCount = Array.isArray(versionsQuery.data) ? versionsQuery.data.length : null;

  const readOnly = status === 'PUBLISHED' || status === 'DEPRECATED';
  const draftFrom = useCreateDraftFrom();
  /** TASK-1036 OD-17 — the latest Test run per node (lane C3), for the inspector's Last run tab and the picker's samples. */
  const lastRunByNode = useNodeLastRuns(definition.id);
  /** The latest Test run laid over the Composer: each step's state and the links that carried data. */
  const runOverlay = useMemo(() => runOverlayFromLastRuns(edges, lastRunByNode), [edges, lastRunByNode]);
  /** The composer's agent resolver — the SAME cached read `ComposerCanvas` types ports with. */
  const { agents } = useComposerAgents();
  // TASK-965 WS-1 (WF-1, WF-26) — validate and publish go through the studio's TanStack mutations,
  // whose `onSuccess` invalidates the whole namespace (rule 13: mutations, never raw client calls).
  const validateMutation = useValidateWorkflowDefinition();
  const publishMutation = usePublishWorkflowDefinition();
  const queryClient = useQueryClient();
  /** Whether the last publish ACTIVATED the version — drives the dialog's published step (O-3). */
  const [publishedActive, setPublishedActive] = useState(true);
  // TASK-885 — the portable-bundle export of the SERVER's stored version (see handleExportBundle).
  const exportBundle = useExportWorkflowDefinition();

  // TASK-893 OD-1 — creating a workflow used to be the definitions grid's job. The grid is gone,
  // so the create affordances (clone / template / import) live in this header instead. One dialog,
  // two entry points: `cloneSource` null WITH the dialog open is "start from a platform template"
  // (the dialog renders the library picker); cloning THIS workflow sets the source, so no picker.
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneSource, setCloneSource] = useState<WorkflowDefinition | null>(null);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const templatesQuery = useWorkflowTemplates(cloneOpen && cloneSource === null);
  const cloneMutation = useCloneWorkflowDefinition();
  const importMutation = useImportWorkflowDefinition();

  // Keyed once per registry fetch, not per hydrate — the inspector needs it live for whichever
  // node is currently selected, not just at hydration time.
  const descriptorByType = useMemo(() => new Map(registryNodes.map((descriptor) => [descriptor.type, descriptor])), [registryNodes]);
  const selectedNodeConfigSchema = selectedNode ? (descriptorByType.get(selectedNode.type)?.configSchema ?? undefined) : undefined;
  // TASK-893 — the inspector's action list IS the action catalogue (`ACTION_CATALOGUE`, the
  // first-class table behind `core.action`), never a filter over deprecated registry types.
  const actionOptions = useMemo(
    () =>
      Object.values(ACTION_CATALOGUE)
        .map((action) => ({ key: action.key, label: humanizeKey(action.key) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [],
  );
  const selectedActionSchema = selectedNode?.type === ACTION_NODE_TYPE ? ACTION_CATALOGUE[actionKeyOf(selectedNode.config) ?? '']?.configSchema : undefined;
  const celReferences = useMemo(() => celReferencesOf(nodes), [nodes]);
  const agentPins = useMemo(() => collectAgentPins(nodes), [nodes]);
  /**
   * TASK-890 black-box J4-F5 — what the trigger binds, so a `core.agent`'s prompt-variable chips
   * can offer this workflow's real `{{trigger.<kindKey>.<field>}}` paths. Read with the same
   * two-key helper `ContextSchemaRefField` writes with, so the editor cannot disagree with the
   * inspector about what is bound.
   */
  const triggerContextBinding = useMemo(() => {
    const trigger = nodes.find((candidate) => candidate.type === 'core.trigger');
    if (!trigger) return undefined;
    const binding = readContextSchemaBinding(trigger.config);
    return { schemaId: binding.schemaId, versionNumber: binding.versionNumber, inline: binding.inline };
  }, [nodes]);

  /**
   * TASK-893 OD-4 — execution order, computed once per graph shape: it numbers the "Connect to…"
   * menu's entries and orders them. The canvas's step badges run the same `computeStepOrder`
   * (inside `ComposerCanvas`), so a node cannot be "③" on the canvas and second in the menu.
   */
  const stepOrder = useMemo(
    () =>
      computeStepOrder(
        nodes.map((node) => ({ id: node.id, type: node.type })),
        edges.map((edge) => ({ source: edge.source, target: edge.target })),
      ),
    [nodes, edges],
  );
  const stepOf = useCallback(
    (nodeId: string): number | null => {
      const entry = stepOrder.get(nodeId);
      return entry && 'step' in entry ? entry.step : null;
    },
    [stepOrder],
  );
  /** Every node in execution order, unordered ones (cycle / unreachable) last. */
  const orderedNodes = useMemo(
    () => [...nodes].sort((a, b) => (stepOf(a.id) ?? Number.MAX_SAFE_INTEGER) - (stepOf(b.id) ?? Number.MAX_SAFE_INTEGER)),
    [nodes, stepOf],
  );

  const hydratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (hydratedRef.current === definition.id) return;
    hydratedRef.current = definition.id;
    // TASK-1036 §3.5 — `graph.settings` is hydrated WITH the graph. Dropping it here is how a
    // workflow's connections / sources / context schema vanished on the next Save.
    const { nodes: loadedNodes, edges: loadedEdges, settings: loadedSettings } = fromWorkflowGraph(definition.graph);
    storeApi.getState().hydrate(
      loadedNodes.map((node) => ({ ...node, safetyClasses: descriptorByType.get(node.type)?.classes ?? node.safetyClasses })),
      loadedEdges,
      loadedSettings,
    );
    setName(definition.name);
    setDescription(definition.description ?? '');
    setMetadataDirty(false);
  }, [definition.id, definition.graph, definition.name, definition.description, descriptorByType, storeApi]);

  const save = useSaveModel({
    definitionId: definition.id,
    getEtag: () => currentEtag,
    onSaved: (saved, nextEtag) => {
      setCurrentEtag(nextEtag ?? etagOf(saved));
      // TASK-965 WS-1 (WF-10) — a graph PATCH rewrites status and report server-side (a VALIDATED
      // row drops back to DRAFT); the header and the publish gate follow the response, not the load.
      if (saved.status) setStatus(saved.status);
      if (saved.validationReport !== undefined) setReport(saved.validationReport);
      storeApi.getState().markSaved(saved.version);
      setMetadataDirty(false);
    },
    onStateChange: (state) => storeApi.getState().setSaveState(state),
    onMissingPrecondition: () => toast.error('Stale tab — the request went out without If-Match. Refresh the page.'),
  });

  // TASK-965 WS-1 (WF-6) — a Save refused for any reason other than a precondition (a 400 on a
  // frozen row, a 409, a 5xx) used to be a badge and nothing else; the gateway's message is the
  // useful part. Conflicts and 428s keep their own alert.
  useEffect(() => {
    const failure = save.lastError;
    if (!failure || failure.isVersionConflict || failure.isMissingPrecondition) return;
    toast.error(failure.message);
  }, [save.lastError]);

  /**
   * Seeded graphs omit `position`, so hydrate piles every node at the origin. Spread them once
   * per definition — a separate effect so React Strict Mode's cancelled first invoke cannot skip
   * the layout the way a combined hydrate+layout effect would (hydratedRef already set, second
   * invoke returns, first invoke's promise aborted).
   *
   * TASK-893 OD-7 — gated on "nothing has a position yet". With autosave gone, `moveNode` marks
   * the graph DIRTY, so laying out a graph that already has stored positions would open every
   * workflow with unsaved changes it never asked for. A read-only version is laid out through
   * `hydrate` instead of `moveNode`: the spread is display bookkeeping there (it can never be
   * saved), so it must not present itself as an edit.
   */
  useEffect(() => {
    const { nodes: current, edges: currentEdges, settings: currentSettings } = storeApi.getState();
    const needsInitialLayout = current.length > 1 && current.every((node) => node.position.x === 0 && node.position.y === 0);
    if (!needsInitialLayout) return;
    let cancelled = false;
    void layoutClusteredGraph(current, currentEdges).then((positions) => {
      if (cancelled || !positions) return;
      // TASK-965 WS-1 (WF-8) — display bookkeeping on BOTH branches. The spread is not an authored
      // edit, so it goes through `hydrate` (which re-baselines and stays clean), never `moveNode`,
      // which marked every positionless template, clone and import "Unsaved" before a single
      // gesture. The positions are persisted by whichever Save the admin makes next.
      storeApi.getState().hydrate(
        current.map((node) => ({ ...node, position: positions[node.id] ?? node.position })),
        currentEdges,
        currentSettings,
      );
      setFitViewKey((key) => key + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [definition.id, storeApi]);

  // Metadata edits join the SAME explicit save the graph uses — they are staged in local state
  // and written by the next `Save`, never by a timer.
  function handleNameChange(next: string) {
    setName(next);
    setMetadataDirty(true);
  }
  function handleDescriptionChange(next: string) {
    setDescription(next);
    setMetadataDirty(true);
  }

  // Unsaved-changes guard — combines the store's graph-shape `dirty` with the local metadata-form
  // flag; a read-only (published) row is never dirty. With no autosave behind it this is the only
  // thing standing between an admin and a closed tab full of lost edits.
  const leaveBlocked = !readOnly && (dirty || metadataDirty);
  useUnsavedChangesGuard(leaveBlocked);
  // TASK-965 WS-1 (WF-7) — every programmatic navigation this editor issues ("New", "Edit as new
  // draft", clone, import, the workflow switcher) asks the same question the anchor guard asks.
  const navigate = useCallback(
    (href: string) => {
      if (confirmLeave(leaveBlocked)) router.push(href);
    },
    [leaveBlocked, router],
  );

  // `!save.paused` is load-bearing, not defensive. `useSaveModel.save()` is deliberately a NO-OP
  // while paused, so that a 412 is never retried without an explicit decision — which means a Save
  // button left enabled after a conflict does nothing at all when pressed, the worst kind of dead
  // control. The `OccConflictAlert` above is the way out: Reload, or Overwrite (which calls
  // `save.resume()`), and only then does Save come back.
  const canSave = !readOnly && !save.paused && (storeCanSave || (metadataDirty && saveState !== 'saving'));
  const canDiscard = !readOnly && (storeCanDiscard || metadataDirty);

  /** What one explicit Save writes, read from the store at click time (never a stale closure). */
  const buildPatch = useCallback((): SaveDefinitionPatch => {
    const { nodes: current, edges: currentEdges, settings: currentSettings, dirty: graphDirty } = storeApi.getState();
    // TASK-965 WS-1 (WF-9) — the graph rides the PATCH only when the STORE is dirty: a graph
    // patch resets VALIDATED → DRAFT server-side, so a rename must not carry one.
    const patch: SaveDefinitionPatch = graphDirty ? { graph: toWorkflowGraph(current, currentEdges, currentSettings) } : {};
    if (metadataDirty) {
      patch.name = name;
      patch.description = description;
    }
    return patch;
  }, [storeApi, metadataDirty, name, description]);

  const handleSave = useCallback(() => {
    void save.save(buildPatch());
  }, [save, buildPatch]);

  const handleDiscard = useCallback(() => {
    storeApi.getState().discard();
    setName(definition.name);
    setDescription(definition.description ?? '');
    setMetadataDirty(false);
    setFitViewKey((key) => key + 1);
    toast.success('Unsaved changes discarded.');
  }, [storeApi, definition.name, definition.description]);

  // "Edit as new draft" (published rows are immutable — edits create versions). TASK-1036 §3.4: the
  // gateway's own `POST …/:id/draft` branches the frozen version into a DRAFT of the same lineage
  // (graph, settings and bindings server-side, not a client copy of whatever this tab loaded). A
  // lineage holds ONE open draft: a 409 `OPEN_DRAFT_EXISTS` names it, and the admin is taken there.
  async function handleCreateNewVersion() {
    try {
      const created = await draftFrom.mutateAsync(definition.id);
      toast.success(`Draft v${created.versionNumber} created from v${definition.versionNumber}.`);
      navigate(`/workflow-studio/${encodeURIComponent(created.id)}`);
    } catch (cause) {
      const body = cause instanceof GatewayError ? (cause.details as { code?: string; draftId?: string } | undefined) : undefined;
      if (cause instanceof GatewayError && cause.status === 409 && body?.code === 'OPEN_DRAFT_EXISTS' && body.draftId) {
        toast.info('This workflow already has an open draft — opening it.');
        navigate(`/workflow-studio/${encodeURIComponent(body.draftId)}`);
        return;
      }
      toast.error(cause instanceof GatewayError ? cause.message : 'Could not create a new draft.');
    }
  }

  function openClone(source: WorkflowDefinition | null) {
    setCloneSource(source);
    setCloneError(null);
    setCloneOpen(true);
  }

  async function handleClone({ sourceId, targetSlug, name: cloneName }: CloneDefinitionSubmission) {
    setCloneError(null);
    try {
      const created = await cloneMutation.mutateAsync({ sourceId, body: { targetSlug, name: cloneName } });
      setCloneOpen(false);
      toast.success(`Cloned into “${created.name}”.`);
      navigate(`/workflow-studio/${encodeURIComponent(created.id)}`);
    } catch (cause) {
      // The gateway's own message is the useful one here — it names the colliding slug, the
      // exceeded quota, or the nodes whose bindings block a template clone.
      const message = cause instanceof GatewayError ? cause.message : 'Failed to clone the workflow.';
      setCloneError(message);
      toast.error(message);
    }
  }

  async function handleImportBundle({ targetSlug, name: importName, bundle }: ImportDefinitionSubmission) {
    setImportError(null);
    try {
      const created = await importMutation.mutateAsync({ targetSlug, name: importName, bundle });
      setImportOpen(false);
      toast.success(`Imported “${created.name}” as a draft — validate it before publishing.`);
      navigate(`/workflow-studio/${encodeURIComponent(created.id)}`);
    } catch (cause) {
      // Surfaced VERBATIM: the gateway's 409 names the references this tenant is missing, and a
      // paraphrase would drop exactly the part that makes it actionable.
      const message = cause instanceof GatewayError ? cause.message : 'Failed to import the workflow.';
      setImportError(message);
      toast.error(message);
    }
  }

  // Stable identity is load-bearing for the canvas: `WorkflowCanvas` (inside `ComposerCanvas`) memoizes its
  // `onSelectionChange` on this callback, and React Flow re-emits the current selection every
  // time that handler's identity changes — an inline arrow here looped selection into
  // "Maximum update depth exceeded".
  // Same discipline as `onSelect`: React Flow re-announces the current selection whenever this
  // handler's identity changes, so it is memoized, and an unchanged set returns the SAME array so
  // the controlled `selectedNodeIds` prop does not churn the canvas memo every announcement.
  const handleSelectionChange = useCallback((nodeIds: string[]) => {
    setSelectedNodeIds((previous) =>
      previous.length === nodeIds.length && previous.every((id, index) => id === nodeIds[index]) ? previous : nodeIds,
    );
  }, []);

  const selectNodeById = useCallback((nodeId: string | null) => storeApi.getState().selectNode(nodeId), [storeApi]);
  const focusNode = useFocusNode({ onSelect: selectNodeById });

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

  /**
   * The keyboard "Connect to…" command (WCAG 2.5.7 — the one non-drag path between two EXISTING
   * steps). TASK-1036 C2c: it runs the composer's own planner (`planConnection`), the same one
   * `ComposerCanvas` runs on a drag, so a keyboard link is typed, auto-mapped and refused for the
   * same reasons a pointer link is. A fan-in refusal is reported with its reason; the "Use first
   * available" choice is offered on the canvas, where the second producer is drawn.
   */
  const connectTo = useCallback(
    (sourceId: string, targetId: string) => {
      if (readOnly) return;
      const state = storeApi.getState();
      const planned = planConnection({ nodes: state.nodes, edges: state.edges, descriptorByType, agents, source: sourceId, target: targetId });
      if (!planned.ok) {
        toast.error(planned.reason);
        return;
      }
      if (planned.request === null) {
        if (planned.binding) state.setInputBinding(targetId, planned.binding.input, planned.binding.binding);
        return;
      }
      const result = state.connect(planned.request, descriptorByType, planned.binding ? { binding: planned.binding } : undefined);
      if (!result.ok) toast.error(result.reason);
      else if (planned.note) toast(planned.note);
    },
    [readOnly, storeApi, descriptorByType, agents],
  );

  /**
   * Palette CLICK — the pointer-free path (WCAG 2.5.7), and the one that nests.
   *
   * TASK-893 §3.8: gated on `readOnly` exactly as the canvas drop is. Before this, clicking a
   * palette card on a PUBLISHED definition mutated the store and marked it dirty for an edit that
   * could never be saved, while the drop path refused — two paths, one rule, opposite answers.
   * TASK-1036 §8.4 item 3 — a PRESET card (Merge) hands its config over with the descriptor.
   */
  const handleAddNode = useCallback(
    (descriptor: WorkflowNodeDescriptor, options?: { config?: Record<string, unknown> }) => {
      if (readOnly) return;
      // TASK-864 B1 — with a loop selected, the new node joins its body (pointer-free
      // nesting: no drag-into-group is ever required).
      const parent = selectedNode?.type === LOOP_NODE_TYPE ? selectedNode : undefined;
      const siblings = parent ? nodes.filter((node) => node.parentId === parent.id).length : nodes.length;
      const position = parent ? { x: 24 + siblings * 260, y: 56 } : { x: 120, y: 120 + siblings * 100 };
      storeApi.getState().addNode({ type: descriptor.type, safetyClasses: descriptor.classes }, position, {
        ...(parent ? { parentId: parent.id } : {}),
        ...(options?.config ? { config: options.config } : {}),
      });
    },
    [readOnly, nodes, selectedNode, storeApi],
  );

  /** The toolbar's "Delete" command; the canvas's own delete path is `ComposerCanvas`'s. */
  const handleDeleteRequest = useCallback(
    (nodeId: string) => {
      const result = storeApi.getState().deleteNode(nodeId);
      if (!result.ok) toast.error(result.reason);
    },
    [storeApi],
  );

  /** TASK-893 OD-5 — a node dragged into, out of, or between loop groups. */
  const handleNodeParentChange = useCallback(
    (nodeId: string, parentId: string | null, position: { x: number; y: number }) => {
      storeApi.getState().setNodeParent(nodeId, parentId, position);
    },
    [storeApi],
  );

  useStudioShortcuts({ enabled: !readOnly, onUndo: handleUndo, onRedo: handleRedo, onDuplicate: duplicateSelected });

  /**
   * TASK-893 §6.8 — every node mutation, as a keyboard-reachable command (WCAG 2.5.7). The List
   * view carried this contract before it was deleted; connect and move-into-loop have NO other
   * non-drag path, so this menu is not a convenience.
   */
  const nodeCommands: StudioNodeCommands | null = useMemo(() => {
    if (!selectedNode) return null;
    const label = (node: { id: string; type: string; config?: Record<string, unknown> }) => {
      const step = stepOf(node.id);
      return step === null ? nodeDisplayName(node) : `${step}. ${nodeDisplayName(node)}`;
    };
    return {
      nodeLabel: nodeDisplayName(selectedNode),
      connectTargets: orderedNodes.filter((node) => node.id !== selectedNode.id).map((node) => ({ id: node.id, label: label(node) })),
      onConnectTo: (targetId: string) => connectTo(selectedNode.id, targetId),
      loopTargets: nodes.filter((node) => node.type === LOOP_NODE_TYPE && node.id !== selectedNode.id).map((node) => ({ id: node.id, label: nodeDisplayName(node) })),
      currentParentId: selectedNode.parentId ?? null,
      onMoveToLoop: (loopId: string | null) => {
        // A group child's `position` is relative to its parent, a top-level node's is absolute —
        // so re-parenting has to restate the position in the NEW frame, which is exactly what
        // `setNodeParent` stores verbatim.
        const parent = selectedNode.parentId ? nodes.find((node) => node.id === selectedNode.parentId) : undefined;
        if (loopId === null) {
          const absolute = parent
            ? { x: parent.position.x + selectedNode.position.x, y: parent.position.y + selectedNode.position.y }
            : selectedNode.position;
          handleNodeParentChange(selectedNode.id, null, absolute);
          return;
        }
        const siblings = nodes.filter((node) => node.parentId === loopId).length;
        handleNodeParentChange(selectedNode.id, loopId, { x: 24 + siblings * 260, y: 56 });
      },
      onWrapInLoop: () => {
        // The whole selection when the admin box- or shift-selected several nodes; otherwise just
        // the primary. `wrapInLoop` refuses a set it cannot legally group and says why.
        const target = selectedNodeIds.length > 1 && selectedNodeIds.includes(selectedNode.id) ? selectedNodeIds : [selectedNode.id];
        const result = storeApi.getState().wrapInLoop(target);
        if (!result.ok) {
          toast.error(result.reason);
          return;
        }
        toast.success(target.length === 1 ? 'Wrapped in a loop.' : `Wrapped ${target.length} nodes in a loop.`);
        if (result.loopId) storeApi.getState().selectNode(result.loopId);
      },
      onUnwrapLoop:
        selectedNode.type === LOOP_NODE_TYPE
          ? () => {
              const result = storeApi.getState().unwrapLoop(selectedNode.id);
              if (!result.ok) toast.error(result.reason);
              else toast.success('Loop unwrapped.');
            }
          : null,
      onDuplicate: () => handleDuplicate(selectedNode.id),
      onDelete: () => handleDeleteRequest(selectedNode.id),
    };
  }, [selectedNode, selectedNodeIds, orderedNodes, nodes, stepOf, connectTo, handleNodeParentChange, handleDuplicate, handleDeleteRequest, storeApi]);

  // TASK-864 B1 — auto layout (built-in layered engine; an ELK engine can be injected later),
  // JSON export and undoable JSON import. Layout moves mark the graph dirty like any other edit;
  // the admin presses Save (OD-7).
  async function handleAutoLayout() {
    const { nodes: current, edges: currentEdges } = storeApi.getState();
    const result = await layoutWorkflowGraph(
      current.map((node) => ({ id: node.id, parentId: node.parentId, kind: node.type === LOOP_NODE_TYPE ? ('group' as const) : ('node' as const) })),
      currentEdges.map((edge) => ({ source: edge.source, target: edge.target })),
    );
    for (const node of current) {
      const position = result.positions[node.id];
      if (position) storeApi.getState().moveNode(node.id, position);
    }
    setFitViewKey((key) => key + 1);
    toast.success('Graph arranged — Save to keep it.');
  }
  function handleExport() {
    const { nodes: current, edges: currentEdges, settings: currentSettings } = storeApi.getState();
    downloadText(GRAPH_EXPORT_FILENAME(definition.slug, definition.versionNumber), exportGraphJson(current, currentEdges, currentSettings));
    toast.success('Graph exported.');
  }
  /**
   * TASK-885 (owner #4) — download the whole definition as a portable bundle.
   *
   * Exports the SERVER's stored version, not the editor buffer: the bundle names a
   * `(slug, versionNumber)` as its provenance, and a file that claims to be v3 while carrying
   * unsaved edits would be a lie an importer has no way to detect. The graph export above is the
   * one that follows the canvas.
   */
  async function handleExportBundle() {
    try {
      const bundle = await exportBundle.mutateAsync(definition.id);
      downloadJson(BUNDLE_EXPORT_FILENAME(definition.slug, definition.versionNumber), bundle);
      toast.success('Workflow bundle exported.');
    } catch (cause) {
      // The gateway's own message names the nodes whose bindings no longer resolve.
      toast.error(cause instanceof Error ? cause.message : 'Failed to export the workflow bundle.');
    }
  }
  function handleImportGraph(text: string) {
    const parsed = parseGraphJson(text);
    if (!parsed.ok) {
      toast.error(`Import refused: ${parsed.reason}`);
      return;
    }
    const { nodes: imported, edges: importedEdges, settings: importedSettings } = fromWorkflowGraph(parsed.graph);
    // TASK-1036 §3.5 — a file that carries `settings` brings them (an export → import round trip
    // is lossless); a file without them leaves the workflow's own settings alone rather than
    // silently clearing its connections. Graph and settings land in ONE undo step.
    storeApi.getState().replaceGraph(
      imported.map((node) => ({ ...node, safetyClasses: descriptorByType.get(node.type)?.classes ?? node.safetyClasses })),
      importedEdges,
      importedSettings,
    );
    void layoutClusteredGraph(imported, importedEdges).then((positions) => {
      if (!positions) return;
      for (const node of imported) {
        const position = positions[node.id];
        if (position) storeApi.getState().moveNode(node.id, position);
      }
      setFitViewKey((key) => key + 1);
    });
    toast.success(`Imported ${imported.length} node${imported.length === 1 ? '' : 's'} — validate before publishing.`);
  }

  const problemsByNodeId = useMemo(() => findingsByNodeId(report?.findings ?? []), [report]);

  async function handleValidate() {
    setValidating(true);
    try {
      // TASK-965 WS-1 (WF-2) — validate COMMITS server-side (the row version moves); adopt the
      // response's ETag and status or the next Save asserts a precondition that is already stale.
      const { data: updated, etag: nextEtag } = await validateMutation.mutateAsync(definition.id);
      setCurrentEtag(nextEtag ?? etagOf(updated));
      setStatus(updated.status);
      setReport(updated.validationReport);
      setInspectorTab('problems');
      setRailPinned(true);
      toast[updated.validationReport?.ok ? 'success' : 'error'](
        updated.validationReport?.ok ? 'Validation passed.' : 'Validation found problems — see the Problems tab.',
      );
    } catch (cause) {
      toast.error(lifecycleFailureMessage(cause, 'Validate failed.'));
    } finally {
      setValidating(false);
    }
  }

  async function handlePublish(activate: boolean) {
    setPublishing(true);
    try {
      // TASK-965 WS-1 (WF-1) — through the mutation, whose success invalidates the studio
      // namespace (definition, versions, switcher); the editor ALSO adopts the response so it locks
      // in the same tick rather than after the refetch lands.
      const { data: published, etag: nextEtag } = await publishMutation.mutateAsync({ id: definition.id, body: { activate } });
      setCurrentEtag(nextEtag ?? etagOf(published));
      setStatus(published.status);
      if (published.validationReport !== undefined) setReport(published.validationReport);
      setPublishedActive(published.isActive);
      toast.success(published.isActive ? 'Published and active.' : 'Published — not active.');
      setJustPublished(true);
    } catch (cause) {
      toast.error(lifecycleFailureMessage(cause, 'Publish failed.'));
    } finally {
      setPublishing(false);
    }
  }

  /**
   * TASK-965 WS-1 (WF-3) — the two `OccConflictAlert` escapes, each now a real path out.
   *
   * Reload latest: the other admin's row REPLACES the buffer (graph, name, description, status,
   * report, ETag) — asked first, because it discards local edits. Overwrite anyway: the buffer
   * WINS — take the fresh ETag, resume, and re-send exactly what is on the canvas. Both read the
   * row through the studio's own detail query (`fetchQuery`, stale by definition) so the cache and
   * the editor agree on what "latest" is.
   */
  async function fetchLatestRow() {
    return queryClient.fetchQuery({ queryKey: workflowStudioKeys.detail(definition.id), queryFn: () => getWorkflowDefinition(definition.id), staleTime: 0 });
  }
  async function handleReloadLatest() {
    if (!window.confirm('Reload the latest version and discard your unsaved edits?')) return;
    try {
      const fresh = await fetchLatestRow();
      const { nodes: loadedNodes, edges: loadedEdges } = fromWorkflowGraph(fresh.data.graph);
      storeApi.getState().hydrate(
        loadedNodes.map((node) => ({ ...node, safetyClasses: descriptorByType.get(node.type)?.classes ?? node.safetyClasses })),
        loadedEdges,
      );
      setName(fresh.data.name);
      setDescription(fresh.data.description ?? '');
      setMetadataDirty(false);
      setStatus(fresh.data.status);
      setReport(fresh.data.validationReport);
      setCurrentEtag(fresh.etag ?? etagOf(fresh.data));
      save.resume();
      setFitViewKey((key) => key + 1);
      toast.success('Reloaded the latest version.');
    } catch (cause) {
      toast.error(cause instanceof GatewayError ? cause.message : 'Could not reload the latest version.');
    }
  }
  async function handleOverwriteAnyway() {
    try {
      const fresh = await fetchLatestRow();
      const latestEtag = fresh.etag ?? etagOf(fresh.data);
      setCurrentEtag(latestEtag);
      save.resume();
      // Same tick as the resume: the override carries the ETag React has not rendered yet.
      void save.save(buildPatch(), { etag: latestEtag });
    } catch (cause) {
      toast.error(cause instanceof GatewayError ? cause.message : 'Could not read the latest version to overwrite it.');
    }
  }

  function openRail(next: InspectorTab) {
    setInspectorTab(next);
    setRailPinned(true);
    void setTab('composer');
  }
  function closeRail() {
    setRailPinned(false);
    selectNodeById(null);
    storeApi.getState().selectEdge(null);
  }

  const findings = report?.findings ?? [];
  const errorCount = findings.filter((finding) => finding.severity === 'ERROR').length;
  const warningCount = findings.filter((finding) => finding.severity === 'WARNING').length;

  const publishDisabledReason = readOnly
    ? 'This version is already published.'
    : // TASK-965 WS-1 (WF-5) — publish freezes the SAVED definition, so a dirty buffer is a stated
      // reason to withhold it. Otherwise the gate is the SERVER's stored report, never a client guess.
      dirty || metadataDirty
      ? 'Save your changes first — publishing freezes the saved definition.'
      : publishBlockedReason(report);

  return (
    <Tabs value={tab} onValueChange={(next) => void setTab(next as StudioTab)} className="min-h-0 flex-1 gap-0">
      <ScreenTemplate
        contentMode="fill"
        header={
          <StudioHeader
            name={name}
            onNameChange={handleNameChange}
            slug={definition.slug}
            status={status}
            versionNumber={definition.versionNumber}
            versionCount={versionCount}
            onOpenHistory={() => setHistoryOpen(true)}
            pins={agentPins}
            onOpenSettings={() => setSettingsOpen(true)}
            onValidate={() => void handleValidate()}
            validating={validating}
            onPublish={() => setPublishOpen(true)}
            publishing={publishing}
            publishDisabledReason={publishDisabledReason}
            readOnly={readOnly}
            needsReview={definition.needsReview}
            actions={
              <>
                <WorkflowSwitcher current={definition} onNavigate={navigate} />
                {readOnly ? (
                  <Button type="button" size="sm" onClick={() => void handleCreateNewVersion()} disabled={draftFrom.isPending}>
                    <IconPlus aria-hidden="true" />
                    {draftFrom.isPending ? 'Creating…' : 'Edit as new draft'}
                  </Button>
                ) : null}
                <Button type="button" variant="outline" size="sm" onClick={() => navigate('/workflow-studio/new')}>
                  <IconPlus aria-hidden="true" />
                  New
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setMetadataOpen(true)}>
                  <IconPencil aria-hidden="true" />
                  Edit details
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="icon-sm" aria-label="More workflow actions">
                      <IconDots aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem onSelect={() => openClone(definition)}>Clone this workflow</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openClone(null)}>Start from a template</DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        setImportError(null);
                        setImportOpen(true);
                      }}
                    >
                      Import a bundle…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            }
          />
        }
        statusBanner={
          <>
            {save.paused ? <OccConflictAlert error={save.lastError} onReload={() => void handleReloadLatest()} onOverwrite={() => void handleOverwriteAnyway()} /> : null}
            {readOnly ? (
              <div role="status" className="border-warning/40 bg-warning/10 text-warning-strong flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <IconLock aria-hidden="true" className="size-4 shrink-0" />
                <span>
                  This version is {status.toLowerCase()}, so the canvas and palette are locked. Create a new draft to keep editing — the
                  graph, its bindings and its history come with it.
                </span>
              </div>
            ) : null}
          </>
        }
        toolbar={
          <StudioToolbar
            saveState={saveState}
            canSave={canSave}
            canDiscard={canDiscard}
            onSave={handleSave}
            onDiscard={handleDiscard}
            readOnly={readOnly}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={handleUndo}
            onRedo={handleRedo}
            problemCount={findings.length}
            onOpenProblems={() => openRail('problems')}
            onOpenTest={() => void setTab('test')}
            onAutoLayout={() => void handleAutoLayout()}
            onExport={handleExport}
            onImport={handleImportGraph}
            onExportBundle={() => void handleExportBundle()}
            exportingBundle={exportBundle.isPending}
            nodeCommands={nodeCommands}
          />
        }
        tabs={
          <TabsList variant="line" aria-label="Workflow studio views">
            <TabsTrigger value="composer">Composer</TabsTrigger>
            <TabsTrigger value="test">Test</TabsTrigger>
            <TabsTrigger value="integration">Integration</TabsTrigger>
          </TabsList>
        }
        footer={
          <StatusFooter
            start={
              <>
                <span>{readOnly ? 'Read-only version.' : dirty || metadataDirty ? 'Unsaved changes — press Save.' : 'All changes saved.'}</span>
                <span>
                  {nodes.length} node{nodes.length === 1 ? '' : 's'} · {edges.length} connection{edges.length === 1 ? '' : 's'}
                </span>
                {/* The report summary is the Problems tab's opener, so the count is not a dead end. */}
                <button
                  type="button"
                  onClick={() => openRail('problems')}
                  className={`hover:text-foreground focus-visible:ring-ring rounded underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none ${
                    errorCount > 0 ? 'text-destructive' : ''
                  }`}
                >
                  {report ? `${errorCount} error${errorCount === 1 ? '' : 's'}, ${warningCount} warning${warningCount === 1 ? '' : 's'}` : 'Not yet validated'}
                </button>
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
        {/* COMPOSER — kept mounted while another tab is open so the canvas keeps its viewport. At
            `md`+ the stage is a positioned box the canvas fills and the panes float over; below it
            the stage is one scrolling column (palette, canvas, inspector in DOM order). */}
        <TabsContent value="composer" forceMount hidden={tab !== 'composer'} className={TAB_PANEL_CLASS}>
          <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto md:block md:overflow-hidden">
            <FloatingPane id="studio-palette" title="Nodes" defaultDock="left" defaultWidth={260} minWidth={200} keepMounted>
              {readOnly ? (
                <p className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs">
                  <IconLock aria-hidden="true" className="size-3.5 shrink-0" />
                  Palette locked on a {status.toLowerCase()} version.
                </p>
              ) : null}
              {/* `inert` (React 19) takes the whole rail out of the tab order and the accessibility
                  tree on a read-only version, so a locked palette cannot be reached and then do
                  nothing. The REASON stays announced above it, outside the inert subtree —
                  `handleAddNode`'s own `readOnly` gate is the second layer. */}
              <div inert={readOnly || undefined} className={readOnly ? 'opacity-60' : undefined}>
                <PaletteRail descriptors={registryNodes} onAddNode={handleAddNode} />
              </div>
            </FloatingPane>

            <div className="h-[26rem] shrink-0 md:absolute md:inset-0 md:h-auto">
              {/* TASK-1036 C2c — the composer's canvas owns every canvas gesture against the store
                  (typed ports, auto-mapped links, `+` on a link, drop, delete, re-parent, move); the
                  editor hands it the registry, the server's findings and the selection. */}
              <ComposerCanvas
                aria-label={`${name} graph`}
                descriptorByType={descriptorByType}
                readOnly={readOnly}
                findings={findings}
                runStates={runOverlay.runStates}
                edgeRunStates={runOverlay.edgeRunStates}
                selectedNodeIds={selectedNodeIds}
                onSelectionChange={handleSelectionChange}
                fitViewKey={fitViewKey}
                emptyState={
                  <Empty>
                    <EmptyMedia variant="icon">
                      <IconTopologyStar3 aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>No nodes yet</EmptyTitle>
                    <EmptyDescription>
                      Add a step — click a palette card, drag it onto the canvas, or use “Add a step”. Every action here also has a keyboard path
                      under “Node actions”.
                    </EmptyDescription>
                  </Empty>
                }
              />
            </div>

            {railOpen ? (
              <FloatingPane id="studio-inspector" title="Inspector" defaultDock="right" defaultWidth={360} minWidth={280} bodyScroll={false} onClose={closeRail}>
                <InspectorPanel
                  node={selectedNode}
                  configSchema={selectedNodeConfigSchema}
                  problems={selectedNode ? (problemsByNodeId.get(selectedNode.id) ?? []) : []}
                  onConfigChange={(config) => selectedNode && storeApi.getState().updateNodeConfig(selectedNode.id, config)}
                  readOnly={readOnly}
                  references={celReferences}
                  actionOptions={selectedNode?.type === ACTION_NODE_TYPE ? actionOptions : undefined}
                  actionSchema={selectedActionSchema}
                  triggerContextBinding={triggerContextBinding}
                  tab={inspectorTab}
                  onTabChange={setInspectorTab}
                  problemCount={findings.length}
                  lastRunByNode={lastRunByNode}
                  problemsSlot={
                    <div className="flex flex-col gap-4">
                      <ValidationRail report={report} nodes={nodes} onActivate={(finding) => finding.nodeId && focusNode(finding.nodeId)} />
                      {/*
                        DD-11 — the "new prompt version available" affordance, in the editor an admin
                        already has open. An out-of-band prompt edit moves no node's pin by design;
                        without this rail that guarantee is invisible and the two-path design decays
                        into "nothing updates".

                        It sits in the PROBLEMS tab rather than its own rail because the tabbed
                        inspector keeps exactly one scroll container (rule 11 §1), and "a binding of
                        yours has drifted" is the same class of thing as a validation finding: something
                        about this workflow that wants your attention.
                      */}
                      <PromptBindingsRail definitionId={definition.id} etag={currentEtag} readOnly={readOnly} onFocusNode={focusNode} />
                    </div>
                  }
                />
              </FloatingPane>
            ) : null}
          </div>
        </TabsContent>

        {visitedTabs.has('test') ? (
          <TabsContent value="test" forceMount hidden={tab !== 'test'} className={TAB_PANEL_CLASS}>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
              {/* A run executes the SERVER's stored graph, not the editor buffer, so unsaved edits
                  are a stated reason to distrust the result rather than a silent mismatch with
                  what is on the canvas. The Save button stays in the toolbar above every tab. */}
              {dirty || metadataDirty ? (
                <p role="status" className="border-warning/40 bg-warning/10 text-warning-strong shrink-0 rounded-md border px-3 py-2 text-sm">
                  Save your changes first — a test run executes the saved definition, not the unsaved edits on the canvas.
                </p>
              ) : null}
              <TestTab definitionId={definition.id} />
            </div>
          </TabsContent>
        ) : null}
        {visitedTabs.has('integration') ? (
          <TabsContent value="integration" forceMount hidden={tab !== 'integration'} className={TAB_PANEL_CLASS}>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <IntegrationTab definitionId={definition.id} unsavedChanges={dirty || metadataDirty} />
            </div>
          </TabsContent>
        ) : null}

        <PublishDialog
          open={publishOpen}
          onOpenChange={(next) => {
            setPublishOpen(next);
            if (!next) setJustPublished(false);
          }}
          onConfirm={(activate) => void handlePublish(activate)}
          confirming={publishing}
          published={justPublished}
          slug={definition.slug}
          activated={publishedActive}
          exposable={definition.paletteKey === CORE_PALETTE_KEY}
          paletteKey={definition.paletteKey}
        />
        <VersionHistorySheet slug={definition.slug} currentDefinitionId={definition.id} open={historyOpen} onOpenChange={setHistoryOpen} />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} readOnly={readOnly} />
        <DefinitionMetadataForm
          open={metadataOpen}
          onOpenChange={setMetadataOpen}
          name={name}
          description={description}
          onNameChange={handleNameChange}
          onDescriptionChange={handleDescriptionChange}
          readOnly={readOnly}
        />
        <CloneDefinitionDialog
          open={cloneOpen}
          onOpenChange={(next) => {
            setCloneOpen(next);
            if (!next) setCloneError(null);
          }}
          source={cloneSource}
          templates={templatesQuery.data ?? []}
          templatesLoading={templatesQuery.isLoading}
          onConfirm={(submission) => void handleClone(submission)}
          confirming={cloneMutation.isPending}
          error={cloneError}
        />
        <ImportDefinitionDialog
          open={importOpen}
          onOpenChange={(next) => {
            setImportOpen(next);
            if (!next) setImportError(null);
          }}
          onConfirm={(submission) => void handleImportBundle(submission)}
          confirming={importMutation.isPending}
          error={importError}
        />
      </ScreenTemplate>
    </Tabs>
  );
}

export function WorkflowStudioEditor(props: WorkflowStudioEditorProps) {
  return (
    <GraphStoreProvider>
      <EditorBody {...props} />
    </GraphStoreProvider>
  );
}
