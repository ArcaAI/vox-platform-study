import { Card } from '@arcaai/ui/components/shadcn/card';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import type { ResidencyDevice } from '../api/types';
import { formatGpuUsage } from './residency-display';

function GpuCard({ device }: { device: ResidencyDevice }) {
  const percent = device.totalBytes > 0 ? Math.round((device.usedBytes / device.totalBytes) * 100) : 0;
  return (
    <Card className="gap-2 p-4">
      <h2 className="truncate text-sm font-medium">{device.label}</h2>
      <p className="text-muted-foreground text-xs">{formatGpuUsage(device.usedBytes, device.totalBytes)}</p>
      <Progress value={percent} aria-label={`${device.label} memory used`} />
      {device.models.length > 0 ? (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label={`Models on ${device.label}`}>
          {device.models.map((model) => (
            <li key={`${model.service}::${model.modelRef}`} className="text-muted-foreground">
              {model.name}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">Nothing loaded on this card.</p>
      )}
    </Card>
  );
}

export interface GpuSummaryPanelProps {
  devices: ResidencyDevice[];
}

/**
 * GPU summary (ticket §13.2 — "GPU summary cards on top"): one card per
 * device naming its used/total memory and the models resident on it.
 * Freshness lives in the page header, not repeated here.
 */
export function GpuSummaryPanel({ devices }: GpuSummaryPanelProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {devices.map((device) => (
        <GpuCard key={device.id} device={device} />
      ))}
    </div>
  );
}
