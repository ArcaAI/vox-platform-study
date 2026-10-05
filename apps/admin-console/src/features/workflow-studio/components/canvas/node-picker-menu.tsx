'use client';

/**
 * `NodePickerMenu` — TASK-1036 §8.4 item 7: the searchable "add a step" command menu, opened by
 * `+` on a link, by a link dropped on empty canvas, and by the "Add a step" button (the keyboard
 * path, WCAG 2.5.7). Lists the palette's presets (Merge) and every registry node type the palette
 * offers (never an action key — an action is chosen inside a `core.action` step).
 */
import { useMemo } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@arcaai/ui';
import type { WorkflowNodeDescriptor } from '../../api/types';
import { PALETTE_PRESETS, type PalettePreset } from '../../lib/palette-presets';
import { nodeTypeTitle } from '../../lib/node-identity';
import { NodeTypeIcon } from '../palette/node-type-icon';

/** The friendly name of a node type — the SAME title the palette and the canvas use (`nodeTypeTitle`): `core.humanReview` → "Review". */
export function stepTypeLabel(type: string): string {
  return nodeTypeTitle(type);
}

export interface NodePickerChoice {
  descriptor: WorkflowNodeDescriptor;
  preset?: PalettePreset;
}

export interface NodePickerMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  descriptors: readonly WorkflowNodeDescriptor[];
  onPick: (choice: NodePickerChoice) => void;
  /** Why the menu is open — "Insert a step between A and B", "Add a step after A". */
  description?: string;
}

function summaryOf(descriptor: WorkflowNodeDescriptor): string | undefined {
  const summary = (descriptor.configSchema as { summary?: unknown } | null)?.summary;
  return typeof summary === 'string' ? summary : undefined;
}

export function NodePickerMenu({ open, onOpenChange, descriptors, onPick, description }: NodePickerMenuProps) {
  const offered = useMemo(
    () => descriptors.filter((descriptor) => descriptor.kind !== 'action' && descriptor.implemented !== false && descriptor.deprecated !== true && descriptor.type !== 'core.trigger'),
    [descriptors],
  );
  const byType = useMemo(() => new Map(offered.map((descriptor) => [descriptor.type, descriptor])), [offered]);
  const presets = PALETTE_PRESETS.filter((preset) => byType.has(preset.type));
  const pick = (choice: NodePickerChoice) => {
    onOpenChange(false);
    onPick(choice);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="sr-only">
          <DialogTitle>Add a step</DialogTitle>
          <DialogDescription>{description ?? 'Search the steps you can add here.'}</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Search steps" aria-label="Search steps" />
          <CommandList>
            <CommandEmpty>No step matches.</CommandEmpty>
            {presets.length > 0 ? (
              <CommandGroup heading="Combine">
                {presets.map((preset) => (
                  <CommandItem key={preset.key} value={`${preset.label} ${preset.summary}`} onSelect={() => pick({ descriptor: byType.get(preset.type) as WorkflowNodeDescriptor, preset })}>
                    <NodeTypeIcon type={preset.type} />
                    <span className="flex min-w-0 flex-col">
                      <span>{preset.label}</span>
                      <span className="text-muted-foreground truncate text-xs">{preset.summary}</span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            <CommandGroup heading="Steps">
              {offered.map((descriptor) => (
                <CommandItem key={descriptor.type} value={`${stepTypeLabel(descriptor.type)} ${descriptor.type} ${summaryOf(descriptor) ?? ''}`} onSelect={() => pick({ descriptor })}>
                  <NodeTypeIcon type={descriptor.type} />
                  <span className="flex min-w-0 flex-col">
                    <span>{stepTypeLabel(descriptor.type)}</span>
                    {summaryOf(descriptor) ? <span className="text-muted-foreground truncate text-xs">{summaryOf(descriptor)}</span> : null}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
