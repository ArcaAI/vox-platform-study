import { cn } from '../../lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../shadcn/select';
import { Label } from '../shadcn/label';
import { Badge } from '../shadcn/badge';
import { IconCpu } from '@tabler/icons-react';

export interface ModelOption {
  id: string;
  name: string;
  source?: 'local' | 'huggingface' | 'backend';
  description?: string;
}

interface ModelSelectorProps {
  label: string;
  models: ModelOption[];
  selectedModelId?: string;
  onChange: (modelId: string) => void;
  isLoading?: boolean;
  className?: string;
  /** When true, prepends a "None" option that passes empty string to onChange */
  noneOption?: boolean;
}

export function ModelSelector({ label, models, selectedModelId, onChange, isLoading, className, noneOption }: ModelSelectorProps) {
  const selectedModel = models.find((m) => m.id === selectedModelId);

  return (
    <div className={cn('space-y-2', className)}>
      <Label>
        <IconCpu className="size-4 text-muted-foreground" />
        {label}
      </Label>

      <Select
        value={selectedModelId || (noneOption ? '__none__' : undefined)}
        onValueChange={(v) => onChange(v === '__none__' ? '' : v)}
        disabled={isLoading}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={isLoading ? 'Loading...' : 'Select a model'}>
            {selectedModelId && selectedModel ? (
              <span className="flex items-center gap-2">
                {selectedModel.name}
                {selectedModel.source && (
                  <Badge variant="secondary" className="text-[10px] leading-tight">
                    {selectedModel.source}
                  </Badge>
                )}
              </span>
            ) : noneOption ? (
              <span className="text-muted-foreground">None (disabled)</span>
            ) : null}
          </SelectValue>
        </SelectTrigger>

        <SelectContent>
          {noneOption && (
            <SelectItem value="__none__">
              <span className="text-muted-foreground">None (disabled)</span>
            </SelectItem>
          )}
          {models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              <div className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  {model.name}
                  {model.source && (
                    <Badge variant="secondary" className="text-[10px] leading-tight">
                      {model.source}
                    </Badge>
                  )}
                </span>
                {model.description && <span className="text-xs text-muted-foreground">{model.description}</span>}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
