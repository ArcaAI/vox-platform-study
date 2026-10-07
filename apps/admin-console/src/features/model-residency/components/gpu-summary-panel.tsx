import { IconCpu } from '@tabler/icons-react';
import { cn } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { EmptyState } from '@/shared/state/empty-state';
import { formatBytes, formatPercent } from '@/shared/format';
import type { ResidencyDevice } from '../api/types';
import { GpuMemoryBar, HATCH_CLASS, SERVICE_LEGEND_LABEL, serviceSwatch, UNATTRIBUTED_SWATCH } from './gpu-memory-bar';
import { splitDeviceLabel } from './residency-display';

function Swatch({ className }: { className: string }) {
  return <span aria-hidden className={cn('size-2.5 shrink-0 rounded-[2px]', className)} />;
}

function DeviceSize({ bytes, source }: { bytes: number | null; source: 'measured' | 'estimated' | 'unknown' }) {
  if (bytes === null || source === 'unknown') return <span className="text-muted-foreground tabular-nums">size unknown</span>;
  return <span className="text-muted-foreground tabular-nums">{source === 'measured' ? formatBytes(bytes) : `~${formatBytes(bytes)} est.`}</span>;
}

function GpuCard({ device }: { device: ResidencyDevice }) {
  const { title, subtitle } = splitDeviceLabel(device.label);
  const headingId = `residency-gpu-${device.id}-title`;
  const room = Math.max(0, device.freeBytes - device.headroomBytes);
  return (
    <Card
      id={`residency-gpu-${device.id}`}
      role="article"
      aria-labelledby={headingId}
      className={cn('scroll-mt-4 gap-3 p-4', device.overHeadroom && 'border-destructive/60')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* C-e: the full label wraps; it is never truncated. */}
          <h3 id={headingId} className="text-sm font-medium break-words">
            {title}
          </h3>
          {subtitle ? <p className="text-muted-foreground text-xs break-words">{subtitle}</p> : null}
        </div>
        {device.overHeadroom ? <Badge variant="destructive">Over headroom</Badge> : <Badge variant="outline">Room for {formatBytes(room)}</Badge>}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-xl font-semibold tabular-nums">{formatBytes(device.usedBytes)}</span>
        <span className="text-muted-foreground text-sm">
          of {formatBytes(device.totalBytes)} · {formatBytes(device.freeBytes)} free
        </span>
        <span className="text-muted-foreground ml-auto text-xs">
          Utilisation {device.utilisationPercent === null ? 'n/a' : formatPercent(device.utilisationPercent)}
        </span>
      </div>

      <GpuMemoryBar device={device} />

      <ul aria-label={`Memory on ${title}`} className="flex flex-col gap-1.5 text-sm">
        {device.models.map((model) => (
          <li key={`${model.service}::${model.modelRef}`} className="flex items-start gap-2">
            <Swatch className={cn('mt-1.5', serviceSwatch(model.service, model.bytesSource !== 'measured'))} />
            <span className="min-w-0 flex-1 break-words">{model.name}</span>
            <DeviceSize bytes={model.bytes} source={model.bytesSource} />
          </li>
        ))}
        {device.unattributedBytes > 0 ? (
          <li className="flex items-start gap-2">
            <Swatch className={cn('mt-1.5', UNATTRIBUTED_SWATCH)} />
            <span className="text-muted-foreground min-w-0 flex-1 break-words">Not attributed — CUDA contexts, other pods on this card</span>
            <span className="text-muted-foreground tabular-nums">{formatBytes(device.unattributedBytes)}</span>
          </li>
        ) : null}
        {device.models.length === 0 && device.unattributedBytes <= 0 ? <li className="text-muted-foreground">Nothing loaded on this card.</li> : null}
      </ul>
    </Card>
  );
}

function Legend({ devices }: { devices: ResidencyDevice[] }) {
  const services = [...new Set(devices.flatMap((device) => device.models.map((model) => model.service)))];
  const headroom = [...new Set(devices.map((device) => 100 - device.headroomPercent))];
  return (
    <ul aria-label="Legend" className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {services.map((service) => (
        <li key={service} className="flex items-center gap-1.5">
          <Swatch className={serviceSwatch(service)} />
          <span>{SERVICE_LEGEND_LABEL[service] ?? service}</span>
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <Swatch className={cn('bg-chart-5 opacity-60', HATCH_CLASS)} />
        <span>Estimated</span>
      </li>
      <li className="flex items-center gap-1.5">
        <Swatch className={UNATTRIBUTED_SWATCH} />
        <span>Not attributed</span>
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="border-destructive h-3 border-l-2 border-dashed" />
        <span>Headroom line</span>
        {headroom.length === 1 ? <span>({headroom[0]}%)</span> : null}
      </li>
    </ul>
  );
}

export interface GpuSummaryPanelProps {
  devices: ResidencyDevice[];
}

/**
 * GPU memory (artboard 01): one card per device with a stacked per-model bar,
 * estimated vs measured, the unattributed remainder, the headroom line and an
 * over-headroom status. Freshness lives in the page header, not repeated here.
 */
export function GpuSummaryPanel({ devices }: GpuSummaryPanelProps) {
  return (
    <section aria-labelledby="residency-gpu-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="residency-gpu-heading" className="text-base font-medium">
          GPU memory
        </h2>
        {devices.length > 0 ? <Legend devices={devices} /> : null}
      </div>
      {devices.length === 0 ? (
        <Card className="p-4">
          <EmptyState icon={IconCpu} title="No GPUs reported" description="No service has reported a device yet." />
        </Card>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr))]">
          {devices.map((device) => (
            <GpuCard key={device.id} device={device} />
          ))}
        </div>
      )}
    </section>
  );
}
