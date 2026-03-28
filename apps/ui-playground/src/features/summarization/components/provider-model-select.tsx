import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Label } from '@arcaai/ui/label';
import { Badge } from '@arcaai/ui/badge';
import { Skeleton } from '@arcaai/ui/skeleton';
import { useSmrProviders } from '../api';
import type { SmrProvider } from '../api';

interface ProviderModelSelectProps {
  provider: string;
  model: string;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
}

interface NormalizedModelOption {
  value: string;
  label: string;
}

export function ProviderModelSelect({ provider, model, onProviderChange, onModelChange }: ProviderModelSelectProps) {
  const { data: providers, isLoading } = useSmrProviders();

  const selectedProvider = providers?.find((p: SmrProvider) => p.name === provider);
  const models: NormalizedModelOption[] = (selectedProvider?.models ?? [])
    .map((rawModel) => {
      if (typeof rawModel === 'string') {
        const value = rawModel.trim();
        return value.length > 0 ? { value, label: value } : null;
      }
      if (rawModel && typeof rawModel === 'object') {
        const value = (rawModel.name ?? rawModel.id ?? '').trim();
        return value.length > 0 ? { value, label: value } : null;
      }
      return null;
    })
    .filter((item): item is NormalizedModelOption => item != null);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Provider</Label>
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="space-y-2">
          <Label>Model</Label>
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label>Provider</Label>
        <Select
          value={provider}
          onValueChange={(v: string) => {
            onProviderChange(v);
            onModelChange('');
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            {providers?.map((p: SmrProvider) => (
              <SelectItem key={p.name} value={p.name} disabled={!p.is_available}>
                <span className="flex items-center gap-2">
                  {p.name}
                  {!p.is_available && (
                    <Badge variant="secondary" className="text-[10px]">
                      offline
                    </Badge>
                  )}
                </span>
              </SelectItem>
            ))}
            {(!providers || providers.length === 0) && <SelectItem value="ollama">ollama</SelectItem>}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Model</Label>
        <Select value={model} onValueChange={onModelChange}>
          <SelectTrigger>
            <SelectValue placeholder={selectedProvider?.default_model || 'Select model'} />
          </SelectTrigger>
          <SelectContent>
            {models.map((m, index) => (
              <SelectItem key={`${m.value}-${index}`} value={m.value}>
                {m.label}
                {m.value === selectedProvider?.default_model && (
                  <Badge variant="outline" className="ml-2 text-[10px]">
                    default
                  </Badge>
                )}
              </SelectItem>
            ))}
            {models.length === 0 && (
              <SelectItem value="_default" disabled>
                No models available
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
