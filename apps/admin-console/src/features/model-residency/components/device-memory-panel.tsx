import { IconAlertTriangle } from '@tabler/icons-react';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { cn } from '@arcaai/ui';
import { formatBytes, formatPercent } from '@/shared/format';
import type { ModelResidencyDevice, ModelResidencyFreshness, ModelResidencyModel } from '../api/types';

const SEGMENT_CLASSES = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'] as const;

function DeviceBar({ device, models }: { device: ModelResidencyDevice; models: ModelResidencyModel[] }) {
  const measured = models.filter((model) => typeof model.bytes === 'number' && model.bytes > 0);
  const measuredTotal = measured.reduce((sum, model) => sum + (model.bytes ?? 0), 0);
  const otherUsed = Math.max(device.usedBytes - measuredTotal, 0);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">
          {device.name} <span className="text-muted-foreground font-mono text-xs">({device.id})</span>
        </span>
        <span className="text-muted-foreground font-mono text-xs">
          {formatBytes(device.usedBytes)} used &middot; {formatBytes(device.freeBytes)} free of {formatBytes(device.totalBytes)} &middot;{' '}
          {formatPercent(device.utilisationPercent)} utilisation
        </span>
      </div>
      {/* Decorative stacked bar (measured bytes per model); the legend beneath
          is the accessible content — the bar itself carries no information a
          sighted-only reader would miss (rule 11 §11: never color-alone). */}
      <div aria-hidden className="bg-muted flex h-3 w-full overflow-hidden rounded-full">
        {measured.map((model, index) => (
          <div
            key={`${model.service}::${model.instance}`}
            className={cn(SEGMENT_CLASSES[index % SEGMENT_CLASSES.length], 'h-full')}
            style={{ width: `${Math.min((model.bytes! / device.totalBytes) * 100, 100)}%` }}
          />
        ))}
        {otherUsed > 0 ? (
          <div className="bg-muted-foreground/40 h-full" style={{ width: `${Math.min((otherUsed / device.totalBytes) * 100, 100)}%` }} />
        ) : null}
      </div>
      {measured.length > 0 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={`Models resident on ${device.name}`}>
          {measured.map((model, index) => (
            <li key={`${model.service}::${model.instance}`} className="flex items-center gap-1.5">
              <span aria-hidden className={cn(SEGMENT_CLASSES[index % SEGMENT_CLASSES.length], 'size-2 shrink-0 rounded-full')} />
              <span className="font-mono">{model.modelRef}</span>
              <span className="text-muted-foreground">{formatBytes(model.bytes)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface DeviceMemoryPanelProps {
  devices: ModelResidencyDevice[];
  models: ModelResidencyModel[];
  freshness: ModelResidencyFreshness;
}

/**
 * Stats region (ScreenTemplate `stats` slot): per-GPU used/free bars with the
 * measured bytes stacked per model, plus a freshness line naming any service
 * whose agent report is stale (ticket §5.4).
 */
export function DeviceMemoryPanel({ devices, models, freshness }: DeviceMemoryPanelProps) {
  return (
    <Card className="gap-3 p-4">
      <ul className="flex flex-col gap-4" aria-label="GPU memory">
        {devices.map((device) => (
          <li key={device.id}>
            <DeviceBar device={device} models={models.filter((model) => model.device === device.id)} />
          </li>
        ))}
      </ul>
      {freshness.staleServices.length > 0 ? (
        <p role="status" className="text-warning-strong flex items-start gap-2 text-xs">
          <IconAlertTriangle aria-hidden className="text-warning mt-0.5 size-3.5 shrink-0" />
          Stale reports (older than {freshness.maxAgeSeconds}s) from: {freshness.staleServices.join(', ')}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">Every service reported within {freshness.maxAgeSeconds}s.</p>
      )}
    </Card>
  );
}
