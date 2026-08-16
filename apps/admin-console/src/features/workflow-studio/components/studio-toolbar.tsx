'use client';

/**
 * `StudioToolbar` (TASK-719 Task 15) — view-mode toggle + autosave-state indicator + Validate /
 * Publish actions. Publish stays disabled until the server report is clean
 * (`publishBlockedReason`, Task 14) — the client validator is never the gate.
 */
import { Badge, Button, ToggleGroup, ToggleGroupItem } from '@arcaai/ui';
import type { AutosaveState, WorkflowStudioViewMode } from '../store/types';

const AUTOSAVE_LABEL: Record<AutosaveState, string> = {
  idle: 'No changes',
  saving: 'Saving…',
  saved: 'Saved',
  conflict: 'Conflict — autosave paused',
  error: 'Save failed',
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
}

export function StudioToolbar({ viewMode, onViewModeChange, autosaveState, onValidate, validating, onPublish, publishDisabledReason, publishing, readOnly }: StudioToolbarProps) {
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
        <Badge variant={autosaveState === 'conflict' || autosaveState === 'error' ? 'destructive' : 'outline'}>{AUTOSAVE_LABEL[autosaveState]}</Badge>
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
