'use client';

/**
 * `StudioToolbar` — view-mode toggle + autosave-state indicator + Validate /
 * Publish actions. Publish stays disabled until the server report is clean
 * (`publishBlockedReason`, Task 14) — the client validator is never the gate.
 */
import { Badge, Button, ToggleGroup, ToggleGroupItem } from '@arcaai/ui';
import { IconArrowBackUp, IconArrowForwardUp, IconDownload, IconFlask, IconLayoutDistributeHorizontal, IconUpload } from '@tabler/icons-react';
import { useId, useRef } from 'react';
import type { AutosaveState, WorkflowStudioViewMode } from '../store/types';

const AUTOSAVE_LABEL: Record<AutosaveState, string> = {
  idle: 'No changes',
  saving: 'Saving…',
  saved: 'Saved',
  conflict: 'Conflict — autosave paused',
  error: 'Save failed',
};

/**
 * (R2) — the "test this workflow" affordance.
 *
 * Running a definition already exists end-to-end in the WORKBENCH
 * (`/playground/workbench`): fixture picker, `POST
 * admin/workflow-definitions/:id/sandbox-runs`, ticket-authenticated progress
 * stream, per-node trace inspector, and the sandbox banner/badge. What the
 * Studio lacked was a way to GET there for the definition on screen.
 *
 * Rule 13 "one authoritative editor per backend resource": the Workbench owns
 * executing a definition, so the Studio demotes to a plain-href deep link — not
 * a cross-feature import, and emphatically not a second sandbox client. The
 * Workbench reads `?definitionId=` as nuqs URL state, so the link lands with the
 * definition already selected.
 */
const WORKBENCH_ROUTE = '/playground/workbench';

/**
 * A sandbox run executes the SERVER's stored graph, not the editor buffer. While
 * autosave is in flight — or has stopped (412 conflict / failure) — what the admin
 * sees on the canvas is not what the interpreter would run, so the link is withheld
 * with a stated reason rather than silently testing a stale graph.
 */
const SANDBOX_BLOCKED_REASON: Partial<Record<AutosaveState, string>> = {
  saving: 'Unsaved changes are not in the sandbox run yet — it executes the saved definition.',
  conflict: 'Unsaved changes are not in the sandbox run — autosave is paused on a conflict.',
  error: 'Unsaved changes are not in the sandbox run — the last save failed.',
};

export interface StudioToolbarProps {
  viewMode: WorkflowStudioViewMode;
  onViewModeChange: (mode: WorkflowStudioViewMode) => void;
  autosaveState: AutosaveState;
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
  /**
   * `WorkflowDefinition.id` of the row being edited, for the Workbench deep link.
   * `null`/absent in create-mode, where there is no server row to run yet.
   */
  sandboxDefinitionId?: string | null;
  /** TASK-864 B1 — arrange the graph (layered, left to right). Absent = no button. */
  onAutoLayout?: () => void;
  /** TASK-864 B1 — hand the caller the graph JSON to save/copy. Absent = no button. */
  onExport?: () => void;
  /** TASK-864 B1 — receives the chosen file's text; the caller parses and refuses. Absent = no button. */
  onImport?: (text: string) => void;
}

export function StudioToolbar({
  viewMode,
  onViewModeChange,
  autosaveState,
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
  sandboxDefinitionId,
  onAutoLayout,
  onExport,
  onImport,
}: StudioToolbarProps) {
  const sandboxBlockedReason = SANDBOX_BLOCKED_REASON[autosaveState] ?? null;
  const importInputId = useId();
  const importInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <ToggleGroup
        type="single"
        variant="outline"
        value={viewMode}
        onValueChange={(value) => {
          // Radix ToggleGroup emits '' when the pressed item is toggled off — a single-select
          // view mode always keeps exactly one value selected, so ignore that case.
          if (value) onViewModeChange(value as WorkflowStudioViewMode);
        }}
        aria-label="Editor view"
      >
        <ToggleGroupItem value="canvas" aria-label="Canvas view">
          Canvas
        </ToggleGroupItem>
        <ToggleGroupItem value="list" aria-label="List view">
          List
        </ToggleGroupItem>
      </ToggleGroup>
      <div className="flex items-center gap-2">
        {!readOnly ? (
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="icon-sm" aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}>
              <IconArrowBackUp aria-hidden="true" />
            </Button>
            <Button type="button" variant="outline" size="icon-sm" aria-label="Redo (Ctrl+Shift+Z)" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}>
              <IconArrowForwardUp aria-hidden="true" />
            </Button>
          </div>
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
            <Button type="button" variant="outline" size="sm" onClick={() => importInputRef.current?.click()} title="Replace this graph with a JSON file (undoable)">
              <IconUpload aria-hidden="true" />
              Import
            </Button>
          </>
        ) : null}
        <Badge variant={autosaveState === 'conflict' || autosaveState === 'error' ? 'destructive' : 'outline'}>{AUTOSAVE_LABEL[autosaveState]}</Badge>
        {/* Offered on read-only (published) versions too — a published graph is the one most
            worth testing, and running it is a read-side action, not an edit. */}
        {sandboxDefinitionId ? (
          sandboxBlockedReason ? (
            <span className="text-muted-foreground text-xs">{sandboxBlockedReason}</span>
          ) : (
            <Button asChild type="button" variant="outline" size="sm">
              <a
                href={`${WORKBENCH_ROUTE}?definitionId=${encodeURIComponent(sandboxDefinitionId)}`}
                title="Run this definition in the Workbench sandbox. Sandbox runs are marked as such and never appear in tenant-facing run lists."
              >
                <IconFlask aria-hidden="true" />
                Test in Workbench
              </a>
            </Button>
          )
        ) : null}
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
