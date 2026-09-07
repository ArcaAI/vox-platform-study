'use client';

/**
 * `StudioToolbar` — the studio's one command strip.
 *
 * TASK-893 OD-7 — **there is no autosave.** The editor buffer is the admin's, and only `Save`
 * writes it: `Undo · Redo · Save · Discard` plus a save-state badge replace the old
 * view-mode toggle and autosave indicator. `Discard` throws away work, so it is confirmed
 * (rule 11 §5) — every other button here is either reversible or a read.
 *
 * TASK-893 §6.8 — `nodeCommands` is the POINTER-FREE path (WCAG 2.5.7) for every node mutation.
 * The List view used to be that path; it is deleted, so connect / move-into-loop / wrap / unwrap /
 * duplicate / remove all have to be reachable from a keyboard-operable menu on the focused node's
 * behalf. Adding is the palette's `<button>`; deleting is also the Delete key. Do not remove this
 * menu without replacing it — it is the ONLY non-drag path for "connect" and "move into a loop".
 *
 * Publish stays disabled until the SERVER report is clean (`publishBlockedReason`) — the client
 * validator is never the gate.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@arcaai/ui';
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconDeviceFloppy,
  IconDots,
  IconDownload,
  IconFileExport,
  IconFlask,
  IconLayoutDistributeHorizontal,
  IconRestore,
  IconUpload,
} from '@tabler/icons-react';
import { useId, useRef } from 'react';
import type { SaveState } from '../store/types';

const SAVE_LABEL: Record<SaveState, string> = {
  clean: 'All changes saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  conflict: 'Conflict — not saved',
  error: 'Save failed',
};

function saveBadgeVariant(state: SaveState): 'outline' | 'secondary' | 'destructive' {
  if (state === 'conflict' || state === 'error') return 'destructive';
  if (state === 'dirty') return 'secondary';
  return 'outline';
}

/**
 * Every node mutation that used to need a drag, as data. Supplied by the editor for the node the
 * admin currently has selected; `null` when nothing is selected (the menu is then disabled, not
 * hidden — a control that vanishes is harder to find again than one that is greyed).
 */
export interface StudioNodeCommands {
  /** The selected node's display name — the menu labels itself with it, so two `core.agent`
   *  boxes are tellable apart before the admin commits to an action. */
  nodeLabel: string;
  /** Nodes this one may be wired to, in execution order. Empty = nothing to connect to. */
  connectTargets: ReadonlyArray<{ id: string; label: string }>;
  onConnectTo: (targetId: string) => void;
  /** The `core.loop` groups on the canvas, for the non-drag re-parent path. */
  loopTargets: ReadonlyArray<{ id: string; label: string }>;
  /** The selected node's current enclosing loop, or `null` at the top level. */
  currentParentId: string | null;
  onMoveToLoop: (loopId: string | null) => void;
  onWrapInLoop: () => void;
  /** `null` when the selected node is not itself a loop. */
  onUnwrapLoop: (() => void) | null;
  onDuplicate: () => void;
  onDelete: () => void;
}

export interface StudioToolbarProps {
  /** TASK-893 OD-7 — the explicit save model; `AutosaveState` is gone. */
  saveState: SaveState;
  canSave: boolean;
  canDiscard: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onValidate: () => void;
  validating?: boolean;
  onPublish: () => void;
  publishDisabledReason: string | null;
  publishing?: boolean;
  readOnly?: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Opens the inspector's Problems tab; the count is the server report's finding total. */
  problemCount: number;
  onOpenProblems: () => void;
  /** Opens the inspector's Run tab — the in-studio sandbox that replaced the Workbench deep link. */
  onOpenRun: () => void;
  /** TASK-864 B1 — arrange the graph (layered, left to right). Absent = no button. */
  onAutoLayout?: () => void;
  /** TASK-864 B1 — hand the caller the graph JSON to save/copy. Absent = no button. */
  onExport?: () => void;
  /** TASK-864 B1 — receives the chosen file's text; the caller parses and refuses. Absent = no button. */
  onImport?: (text: string) => void;
  /**
   * TASK-885 (owner #4) — download the whole DEFINITION as a portable bundle.
   *
   * Distinct from `onExport` above, and the labels say so: `Export` writes THIS GRAPH's nodes and
   * edges with the tenant's own row ids in them (a working file for this tenant); `Export bundle`
   * writes the definition — name, palette, graph AND its catalogue bindings translated into
   * portable keys — which is the artifact another tenant can import. Absent = no button.
   */
  onExportBundle?: () => void;
  exportingBundle?: boolean;
  /** TASK-893 §6.8 — the keyboard path for node mutations. `null` = nothing selected. */
  nodeCommands?: StudioNodeCommands | null;
}

export function StudioToolbar({
  saveState,
  canSave,
  canDiscard,
  onSave,
  onDiscard,
  onValidate,
  validating,
  onPublish,
  publishDisabledReason,
  publishing,
  readOnly,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  problemCount,
  onOpenProblems,
  onOpenRun,
  onAutoLayout,
  onExport,
  onImport,
  onExportBundle,
  exportingBundle,
  nodeCommands,
}: StudioToolbarProps) {
  const importInputId = useId();
  const importInputRef = useRef<HTMLInputElement>(null);
  return (
    <div role="group" aria-label="Workflow studio actions" className="flex flex-wrap items-center gap-2">
      {!readOnly ? (
        <>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Undo (Ctrl+Z)"
              title="Undo (Ctrl+Z)"
              disabled={!canUndo}
              onClick={onUndo}
            >
              <IconArrowBackUp aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Redo (Ctrl+Shift+Z)"
              title="Redo (Ctrl+Shift+Z)"
              disabled={!canRedo}
              onClick={onRedo}
            >
              <IconArrowForwardUp aria-hidden="true" />
            </Button>
          </div>
          <Button type="button" size="sm" onClick={onSave} disabled={!canSave} title="Write this graph to the server (If-Match)">
            <IconDeviceFloppy aria-hidden="true" />
            {saveState === 'saving' ? 'Saving…' : 'Save'}
          </Button>
          {/* Discarding throws away unsaved work and cannot be undone (the undo stack is cleared
              with it), so it is confirmed rather than one click away — rule 11 §5. */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="outline" size="sm" disabled={!canDiscard} title="Revert to the last saved version of this graph">
                <IconRestore aria-hidden="true" />
                Discard
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
                <AlertDialogDescription>
                  The graph reverts to the last version you saved, and the undo history is cleared. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep editing</AlertDialogCancel>
                <AlertDialogAction onClick={onDiscard}>Discard changes</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
      <Badge variant={saveBadgeVariant(saveState)}>{readOnly ? 'Read-only' : SAVE_LABEL[saveState]}</Badge>

      {!readOnly && nodeCommands !== undefined ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!nodeCommands}
              title={nodeCommands ? `Actions for ${nodeCommands.nodeLabel}` : 'Select a node on the canvas first'}
            >
              <IconDots aria-hidden="true" />
              Node actions
            </Button>
          </DropdownMenuTrigger>
          {nodeCommands ? (
            <DropdownMenuContent align="start" className="w-60">
              <DropdownMenuLabel className="truncate">{nodeCommands.nodeLabel}</DropdownMenuLabel>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Connect to…</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                  {nodeCommands.connectTargets.length === 0 ? (
                    <DropdownMenuItem disabled>No other node to connect to</DropdownMenuItem>
                  ) : (
                    nodeCommands.connectTargets.map((target) => (
                      <DropdownMenuItem key={target.id} onSelect={() => nodeCommands.onConnectTo(target.id)}>
                        <span className="truncate">{target.label}</span>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Move into…</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                  <DropdownMenuItem disabled={nodeCommands.currentParentId === null} onSelect={() => nodeCommands.onMoveToLoop(null)}>
                    Top level
                  </DropdownMenuItem>
                  {nodeCommands.loopTargets.length === 0 ? (
                    <DropdownMenuItem disabled>No loop on this canvas</DropdownMenuItem>
                  ) : (
                    nodeCommands.loopTargets.map((loop) => (
                      <DropdownMenuItem key={loop.id} disabled={loop.id === nodeCommands.currentParentId} onSelect={() => nodeCommands.onMoveToLoop(loop.id)}>
                        <span className="truncate">{loop.label}</span>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onSelect={nodeCommands.onWrapInLoop}>Wrap in loop</DropdownMenuItem>
              {nodeCommands.onUnwrapLoop ? <DropdownMenuItem onSelect={nodeCommands.onUnwrapLoop}>Unwrap loop</DropdownMenuItem> : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={nodeCommands.onDuplicate}>Duplicate</DropdownMenuItem>
              <DropdownMenuItem onSelect={nodeCommands.onDelete}>Remove node</DropdownMenuItem>
            </DropdownMenuContent>
          ) : null}
        </DropdownMenu>
      ) : null}

      {!readOnly && onAutoLayout ? (
        <Button type="button" variant="outline" size="sm" onClick={onAutoLayout} title="Arrange the nodes in layers, left to right">
          <IconLayoutDistributeHorizontal aria-hidden="true" />
          Auto layout
        </Button>
      ) : null}
      {onExport ? (
        <Button type="button" variant="outline" size="sm" onClick={onExport} title="Download this graph as JSON">
          <IconDownload aria-hidden="true" />
          Export
        </Button>
      ) : null}
      {onExportBundle ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onExportBundle}
          disabled={exportingBundle}
          title="Download the whole workflow as a portable bundle — another tenant can import this file"
        >
          <IconFileExport aria-hidden="true" />
          {exportingBundle ? 'Exporting…' : 'Export bundle'}
        </Button>
      ) : null}
      {!readOnly && onImport ? (
        <>
          <input
            ref={importInputRef}
            id={importInputId}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="Import graph JSON"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              void file.text().then(onImport);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => importInputRef.current?.click()}
            title="Replace this graph with a JSON file (undoable)"
          >
            <IconUpload aria-hidden="true" />
            Import
          </Button>
        </>
      ) : null}

      <div className="ms-auto flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenProblems}
          title="Show the server validation report for this workflow"
        >
          <IconAlertTriangle aria-hidden="true" />
          Problems
          {problemCount > 0 ? <Badge variant="secondary">{problemCount}</Badge> : null}
        </Button>
        {/* TASK-893 OD-3 — testing moved INTO the studio. This opens the inspector's Run tab
            (fixture picker + live progress + per-node overlays); it used to be a deep link out to
            `/playground/workbench`, which is now a redirect stub back here. Offered on read-only
            versions too — a published graph is the one most worth running, and a run is a read. */}
        <Button type="button" variant="outline" size="sm" onClick={onOpenRun} title="Run this workflow against a fixture in the sandbox">
          <IconFlask aria-hidden="true" />
          Test
        </Button>
        {!readOnly ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={onValidate} disabled={validating}>
              {validating ? 'Validating…' : 'Validate'}
            </Button>
            <span title={publishDisabledReason ?? undefined}>
              <Button type="button" size="sm" onClick={onPublish} disabled={publishDisabledReason !== null || publishing}>
                {publishing ? 'Publishing…' : 'Publish'}
              </Button>
            </span>
            {publishDisabledReason ? <span className="text-muted-foreground text-xs">{publishDisabledReason}</span> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
