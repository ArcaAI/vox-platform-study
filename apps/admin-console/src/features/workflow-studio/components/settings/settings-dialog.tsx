'use client';

/**
 * Workflow settings dialog (TASK-1036 §3.5, OD-4/OD-5): how callers reach the workflow
 * (connections), what starts it on the platform (sources), and its Input shape (the context
 * schema). Writes `graph.settings` through the store (`setSettings`: undoable, marks the graph
 * dirty, persisted by the next Save, checksummed and frozen at publish).
 *
 * Implications are LIVE and come from the contract (`settingsImplications`, WF-SET-001..004): a
 * connection the graph or the Input shape requires is shown checked and LOCKED with the reason,
 * and Save writes the closed set — the dialog can never save what publish would refuse. A
 * consultation-sourced ASR step does not need the socket (its audio arrives on the consultation
 * session, Q6).
 *
 * The header (lane C2a) opens it; keep the props contract stable.
 */
import { useId, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FieldDescription,
  FieldLegend,
  FieldSet,
  Label,
} from '@arcaai/ui';
import { IconLock } from '@tabler/icons-react';
import { WORKFLOW_SOURCES, type WorkflowConnection, type WorkflowContextSchemaSetting, type WorkflowSource } from '@arcaai/workflow-contract';
import { useContextSchemaDefinition } from '@/shared/catalog';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';
import { SOURCE_COPY, connectionOptions, settingsDraftOf, toWorkflowSettings, withImpliedConnections, type SettingsDraft } from '../../lib/settings-model';
import { useComposerData } from '../canvas/use-composer-data';
import { ContextSchemaRefField } from '../inspector/context-schema-ref-field';

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnly?: boolean;
}

/** `{ contextSchemaId, versionNumber? } | { inline }` (the trigger field's shape) → the settings shape. */
function toContextSchemaSetting(value: unknown): WorkflowContextSchemaSetting | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.contextSchemaId === 'string' && object.contextSchemaId.length > 0) {
    return { contextSchemaId: object.contextSchemaId, versionNumber: typeof object.versionNumber === 'number' ? object.versionNumber : null };
  }
  if (object.inline !== null && typeof object.inline === 'object' && !Array.isArray(object.inline)) return { inline: object.inline as Record<string, unknown> };
  return undefined;
}

/** The settings shape → the trigger field's (`versionNumber: null` = follow latest = absent). */
function toFieldConfig(setting: WorkflowContextSchemaSetting | undefined): Record<string, unknown> {
  if (!setting) return { contextSchema: {} };
  if ('inline' in setting) return { contextSchema: { inline: setting.inline } };
  return { contextSchema: { contextSchemaId: setting.contextSchemaId, ...(setting.versionNumber !== null ? { versionNumber: setting.versionNumber } : {}) } };
}

export function SettingsDialog({ open, onOpenChange, readOnly }: SettingsDialogProps) {
  const composer = useComposerData();
  const uid = useId();
  // The author's edits; `null` = untouched, so the dialog shows the graph's current settings even
  // when they change underneath it (a hydrate, an undo) before the first edit.
  const [edited, setEdited] = useState<SettingsDraft | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setEdited(null);
  }

  const nodes = composer?.nodes ?? [];
  const current = settingsDraftOf(nodes, composer?.settings);
  const draft = edited ?? current;
  const reference = draft.contextSchema && 'contextSchemaId' in draft.contextSchema ? draft.contextSchema : null;
  const definition = useContextSchemaDefinition(reference?.contextSchemaId ?? null, reference?.versionNumber ?? null);
  const ctx = {
    agents: composer?.agents ?? {},
    contextSchemaDefinition: draft.contextSchema && 'inline' in draft.contextSchema ? undefined : (definition.definition ?? undefined),
  };
  const options = connectionOptions(draft, nodes, ctx);
  const update = (next: Partial<SettingsDraft>) => setEdited({ ...draft, ...next });

  const toggleConnection = (value: WorkflowConnection, checked: boolean) =>
    update({ connections: checked ? [...draft.connections, value] : draft.connections.filter((name) => name !== value) });
  const toggleSource = (value: WorkflowSource, checked: boolean) => update({ sources: checked ? [...draft.sources, value] : draft.sources.filter((name) => name !== value) });

  const save = () => {
    if (!composer || readOnly) return;
    composer.storeApi.getState().setSettings(toWorkflowSettings(withImpliedConnections(draft, nodes, ctx)));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`${DIALOG_SIZE_CLASS.lg}`}>
        <DialogHeader className="shrink-0">
          <DialogTitle>Workflow settings</DialogTitle>
          <DialogDescription>How callers reach this workflow, what starts it, and the shape of its input. Saved with the graph and frozen when you publish.</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pr-1">
          <FieldSet disabled={readOnly}>
            <FieldLegend>Connections</FieldLegend>
            <FieldDescription>Ways a developer’s app can call this workflow. Some are required by what the workflow does — those are locked on, with the reason.</FieldDescription>
            <ul className="flex flex-col gap-3">
              {options.map((option) => {
                const id = `${uid}-connection-${option.value}`;
                return (
                  <li key={option.value} className="flex items-start gap-3">
                    <Checkbox
                      id={id}
                      checked={option.checked}
                      disabled={readOnly || option.locked}
                      aria-describedby={`${id}-description`}
                      onCheckedChange={(checked) => toggleConnection(option.value, checked === true)}
                    />
                    <div className="flex flex-col gap-0.5">
                      <Label htmlFor={id} className="flex items-center gap-1">
                        {option.label}
                        {option.locked ? <IconLock aria-hidden="true" className="text-muted-foreground size-3.5" /> : null}
                      </Label>
                      <span id={`${id}-description`} className="text-muted-foreground text-xs">
                        {option.description}
                        {option.lockReason ? <span className="text-foreground mt-0.5 block">Required: {option.lockReason}</span> : null}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </FieldSet>

          <FieldSet disabled={readOnly}>
            <FieldLegend>Sources</FieldLegend>
            <FieldDescription>What starts this workflow on the platform, besides the connections above.</FieldDescription>
            <ul className="flex flex-col gap-3">
              {WORKFLOW_SOURCES.map((value) => {
                const id = `${uid}-source-${value}`;
                return (
                  <li key={value} className="flex items-start gap-3">
                    <Checkbox id={id} checked={draft.sources.includes(value)} disabled={readOnly} aria-describedby={`${id}-description`} onCheckedChange={(checked) => toggleSource(value, checked === true)} />
                    <div className="flex flex-col gap-0.5">
                      <Label htmlFor={id}>{SOURCE_COPY[value].label}</Label>
                      <span id={`${id}-description`} className="text-muted-foreground text-xs">
                        {SOURCE_COPY[value].description}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </FieldSet>

          <section aria-labelledby={`${uid}-shape`} className="flex flex-col gap-2">
            <h3 id={`${uid}-shape`} className="text-sm font-medium">
              Input shape
            </h3>
            <ContextSchemaRefField
              idPrefix={`${uid}-settings`}
              config={toFieldConfig(draft.contextSchema)}
              onConfigChange={(next) => {
                const setting = toContextSchemaSetting(next.contextSchema);
                const { contextSchema: _previous, ...rest } = draft;
                setEdited(setting ? { ...rest, contextSchema: setting } : rest);
              }}
              disabled={readOnly}
            />
          </section>
        </div>
        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly ? (
            <Button type="button" onClick={save} disabled={!composer}>
              Save settings
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
