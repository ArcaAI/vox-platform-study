'use client';

/**
 * TASK-1036 W2 (§8.6) — the fallback chain in the draft editor, edited by MODEL NAME.
 *
 * The draft editor used to print the chain as text with no way to change it; §8.6 lists fallbacks
 * among the few things a tenant sets. Same behaviour as the create wizard's list (add in order,
 * remove any), and the same TASK-958 option label, which names the connection a BYO model spends.
 */
import { useId } from 'react';
import { IconX } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import type { AgentTask } from '../api';
import { fallbackModelOptionLabel, useTaskModelCatalogue } from './model-picker';

export interface FallbackModelsFieldProps {
  task: AgentTask;
  /** The primary model — never offered as its own fallback. */
  primaryModelId: string;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

export function FallbackModelsField({ task, primaryModelId, value, onChange, disabled }: FallbackModelsFieldProps) {
  const id = useId();
  const catalogue = useTaskModelCatalogue(task);
  const label = (modelId: string) => {
    const model = catalogue.models.find((candidate) => candidate.id === modelId);
    return model ? fallbackModelOptionLabel(model, catalogue.providers) : 'Model no longer available';
  };
  const candidates = catalogue.models.filter((model) => model.usable && model.id !== primaryModelId && !value.includes(model.id));

  return (
    <fieldset className="flex flex-col gap-1.5" aria-describedby={`${id}-desc`}>
      <legend className="text-sm font-medium">Fallback models</legend>
      <p id={`${id}-desc`} className="text-muted-foreground text-xs">
        Used in order when the main model is unavailable. Optional.
      </p>
      {value.length ? (
        <ol className="flex flex-wrap gap-2">
          {value.map((modelId, index) => (
            <li key={modelId}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                aria-label={`Remove fallback ${label(modelId)}`}
                onClick={() => onChange(value.filter((other) => other !== modelId))}
              >
                {index + 1}. {label(modelId)}
                <IconX aria-hidden className="size-3" />
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
      <Select value="" onValueChange={(modelId) => onChange(value.includes(modelId) ? value : [...value, modelId])} disabled={disabled || candidates.length === 0}>
        <SelectTrigger id={`${id}-add`} aria-label="Add a fallback model" className="w-full">
          <SelectValue placeholder={candidates.length ? 'Add a fallback model' : 'No other model available'} />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              {fallbackModelOptionLabel(model, catalogue.providers)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </fieldset>
  );
}
