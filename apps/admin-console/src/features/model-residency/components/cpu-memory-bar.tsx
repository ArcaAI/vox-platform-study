import { cn } from '@arcaai/ui';
import { formatBytes } from '@/shared/format';
import type { ResidencyCpuSummary } from '../api/types';
import { serviceSwatch, UNATTRIBUTED_SWATCH } from './gpu-memory-bar';

function percentOf(bytes: number, total: number): number {
  return total > 0 ? (bytes / total) * 100 : 0;
}

/** One-sentence summary for `role="img"` (the bar carries no text of its own). */
export function cpuBarSummary(cpu: ResidencyCpuSummary): string {
  const { node } = cpu;
  const named = cpu.services
    .filter((service) => (service.memoryBytes ?? 0) > 0)
    .map((service) => `${service.label} ${formatBytes(service.memoryBytes!)}`)
    .join(', ');
  return (
    `${node.label}: ${named || 'no service memory reported'}; ${formatBytes(cpu.unattributedBytes)} not attributed, ` +
    `${formatBytes(node.freeBytes)} free; ${formatBytes(node.headroomBytes)} should stay free (headroom line at ${100 - node.headroomPercent}%)`
  );
}

interface BarSegment {
  key: string;
  service: string;
  width: number;
}

/** One segment per service, then the unattributed remainder; clamped so the stack never exceeds 100%. */
function barSegments(cpu: ResidencyCpuSummary): BarSegment[] {
  const total = cpu.node.totalBytes;
  const raw: BarSegment[] = cpu.services
    .filter((service) => service.memoryBytes !== null && service.memoryBytes > 0)
    .map((service) => ({ key: service.service, service: service.service, width: percentOf(service.memoryBytes!, total) }));
  if (cpu.unattributedBytes > 0) raw.push({ key: 'unattributed', service: 'unattributed', width: percentOf(cpu.unattributedBytes, total) });
  return raw.reduce<{ out: BarSegment[]; left: number }>(
    (acc, segment) => {
      const width = Math.min(segment.width, acc.left);
      return width > 0 ? { out: [...acc.out, { ...segment, width }], left: acc.left - width } : acc;
    },
    { out: [], left: 100 },
  ).out;
}

/** Stacked host-memory bar: per-service segments, the unattributed remainder (hatched), free space, and the headroom line. */
export function CpuMemoryBar({ cpu }: { cpu: ResidencyCpuSummary }) {
  const segments = barSegments(cpu);
  return (
    <div role="img" aria-label={cpuBarSummary(cpu)} className="bg-muted relative h-4 w-full rounded-sm">
      <div className="flex h-full w-full overflow-hidden rounded-sm">
        {segments.map((segment) => (
          <span
            key={segment.key}
            data-slot="cpu-segment"
            data-service={segment.service}
            className={cn('h-full', segment.service === 'unattributed' ? UNATTRIBUTED_SWATCH : cn('border-background border-r', serviceSwatch(segment.service)))}
            style={{ width: `${segment.width}%` }}
          />
        ))}
      </div>
      <span
        aria-hidden
        data-slot="cpu-headroom-marker"
        className="border-destructive absolute -top-1 -bottom-1 border-l-2 border-dashed"
        style={{ left: `${100 - cpu.node.headroomPercent}%` }}
      />
    </div>
  );
}
