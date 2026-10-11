import { IconCpu } from '@tabler/icons-react';
import { cn } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { EmptyState } from '@/shared/state/empty-state';
import { formatBytes, formatPercent } from '@/shared/format';
import type { ResidencyCpuService, ResidencyCpuSummary } from '../api/types';
import { CpuMemoryBar } from './cpu-memory-bar';
import { serviceSwatch, UNATTRIBUTED_SWATCH } from './gpu-memory-bar';
import { DeviceSize, Swatch } from './gpu-summary-panel';

const cores = (value: number): string => `${Number.isInteger(value) ? value : Number(value.toFixed(2))}`;

function memoryText(service: ResidencyCpuService): string {
  if (service.memoryBytes === null) return 'n/a';
  return service.memoryLimitBytes === null
    ? formatBytes(service.memoryBytes)
    : `${formatBytes(service.memoryBytes)} of ${formatBytes(service.memoryLimitBytes)} limit`;
}

function coresText(service: ResidencyCpuService): string {
  if (service.cpuCores === null) return 'CPU n/a';
  const parts = [`${cores(service.cpuCores)} cores`];
  if (service.cpuRequestCores !== null) parts.push(`request ${cores(service.cpuRequestCores)}`);
  if (service.cpuLimitCores !== null) parts.push(`limit ${cores(service.cpuLimitCores)}`);
  return parts.join(' · ');
}

function ServiceRow({ service }: { service: ResidencyCpuService }) {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-0.5">
        <Swatch className={cn('mt-1.5', serviceSwatch(service.service))} />
        <span className="min-w-0 flex-1 font-medium break-words">{service.label}</span>
        <span className="tabular-nums">{memoryText(service)}</span>
        <span className="text-muted-foreground w-full pl-[1.125rem] text-xs tabular-nums">{coresText(service)}</span>
      </div>
      {/* The remainder row only means something next to models: without any, it would restate the whole working set. */}
      {service.models.length > 0 ? (
        <ul aria-label={`Models in ${service.label}`} className="flex flex-col gap-1 pl-[1.125rem] text-sm">
          {service.models.map((model) => (
            <li key={`${model.service}::${model.modelRef}`} className="flex items-start gap-2">
              <Swatch className={cn('mt-1.5', serviceSwatch(model.service, model.bytesSource !== 'measured'))} />
              <span className="min-w-0 flex-1 break-words">{model.name}</span>
              <DeviceSize bytes={model.bytes} source={model.bytesSource} />
            </li>
          ))}
          {service.unattributedBytes > 0 ? (
            <li className="flex items-start gap-2">
              <Swatch className={cn('mt-1.5', UNATTRIBUTED_SWATCH)} />
              <span className="text-muted-foreground min-w-0 flex-1 break-words">Not attributed — runtime, buffers, freed-but-retained memory</span>
              <span className="text-muted-foreground tabular-nums">{formatBytes(service.unattributedBytes)}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function NodeCard({ cpu }: { cpu: ResidencyCpuSummary }) {
  const { node } = cpu;
  const room = Math.max(0, node.freeBytes - node.headroomBytes);
  const headingId = 'residency-cpu-node-title';
  return (
    <Card id="residency-cpu-node" role="article" aria-labelledby={headingId} className={cn('gap-3 p-4', node.overHeadroom && 'border-destructive/60')}>
      <div className="flex items-start justify-between gap-3">
        <h3 id={headingId} className="min-w-0 text-sm font-medium break-words">
          {node.label}
        </h3>
        {node.overHeadroom ? <Badge variant="destructive">Over headroom</Badge> : <Badge variant="outline">Room for {formatBytes(room)}</Badge>}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-xl font-semibold tabular-nums">{formatBytes(node.usedBytes)}</span>
        <span className="text-muted-foreground text-sm">
          of {formatBytes(node.totalBytes)} · {formatBytes(node.freeBytes)} free
        </span>
        <span className="text-muted-foreground ml-auto text-xs">
          {node.utilisationPercent === null || node.cpuCores === null
            ? 'CPU n/a'
            : `CPU ${formatPercent(node.utilisationPercent)} of ${cores(node.cpuCores)} cores`}
        </span>
      </div>

      <CpuMemoryBar cpu={cpu} />

      <ul aria-label="Services on the host" className="flex flex-col gap-2 text-sm">
        {cpu.services.map((service) => (
          <ServiceRow key={service.service} service={service} />
        ))}
        {cpu.unattributedBytes > 0 ? (
          <li className="flex items-start gap-2">
            <Swatch className={cn('mt-1.5', UNATTRIBUTED_SWATCH)} />
            <span className="text-muted-foreground min-w-0 flex-1 break-words">Not attributed — kernel and system</span>
            <span className="text-muted-foreground tabular-nums">{formatBytes(cpu.unattributedBytes)}</span>
          </li>
        ) : null}
      </ul>

      {cpu.source === 'agents' ? (
        <p className="text-muted-foreground text-xs">{"Per-service CPU and limits need cluster metrics; showing the services' own reports."}</p>
      ) : null}
      <p className="text-muted-foreground text-xs">CPU time is measured per service; it cannot be split per model.</p>
    </Card>
  );
}

/** CPU & host memory: the node's memory split by service, the unattributed remainder, headroom, and per-service CPU. */
export function CpuSummaryPanel({ cpu }: { cpu: ResidencyCpuSummary | null }) {
  return (
    <section aria-labelledby="residency-cpu-heading" className="flex flex-col gap-3">
      <h2 id="residency-cpu-heading" className="text-base font-medium">
        CPU &amp; host memory
      </h2>
      {cpu === null ? (
        <Card className="p-4">
          <EmptyState icon={IconCpu} title="No host metrics reported" description="No service or cluster metric has reported host memory yet." />
        </Card>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr))]">
          <NodeCard cpu={cpu} />
        </div>
      )}
    </section>
  );
}
