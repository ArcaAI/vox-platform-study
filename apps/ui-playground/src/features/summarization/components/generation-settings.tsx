import { Label } from '@arcaai/ui/label';
import { Slider } from '@arcaai/ui/slider';
import { Input } from '@arcaai/ui/input';
import { Switch } from '@arcaai/ui/switch';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@arcaai/ui/collapsible';
import { Button } from '@arcaai/ui/button';
import { ChevronDown, Settings2 } from 'lucide-react';
import { useState } from 'react';

interface GenerationSettingsProps {
  temperature: number;
  maxTokens: number;
  includeNER: boolean;
  onTemperatureChange: (value: number) => void;
  onMaxTokensChange: (value: number) => void;
  onIncludeNERChange: (value: boolean) => void;
  showNER?: boolean;
}

export function GenerationSettings({
  temperature,
  maxTokens,
  includeNER,
  onTemperatureChange,
  onMaxTokensChange,
  onIncludeNERChange,
  showNER = true,
}: GenerationSettingsProps) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 text-xs">
          <Settings2 className="size-3.5" />
          Advanced Settings
          <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-4 rounded-lg border p-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Temperature</Label>
            <span className="text-muted-foreground text-xs font-mono">{temperature.toFixed(2)}</span>
          </div>
          <Slider
            value={[temperature]}
            onValueChange={([v]) => onTemperatureChange(v)}
            min={0}
            max={2}
            step={0.05}
          />
          <p className="text-muted-foreground text-[11px]">
            Lower = more focused, Higher = more creative
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="max-tokens" className="text-xs">Max Tokens</Label>
          <Input
            id="max-tokens"
            type="number"
            min={256}
            max={16384}
            value={maxTokens}
            onChange={(e) => onMaxTokensChange(Number(e.target.value) || 2048)}
            className="h-8 text-xs"
          />
        </div>

        {showNER && (
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs">Include NER Extraction</Label>
              <p className="text-muted-foreground text-[11px]">
                Extract medications, conditions, procedures
              </p>
            </div>
            <Switch checked={includeNER} onCheckedChange={onIncludeNERChange} />
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
