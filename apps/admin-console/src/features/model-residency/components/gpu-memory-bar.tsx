import { cn } from '@arcaai/ui';
import { formatBytes } from '@/shared/format';
import type { ResidencyDevice } from '../api/types';
import { splitDeviceLabel } from './residency-display';

/**
 * Per-service swatch classes (chart tokens from `@arcaai/ui` globals — both
 * themes contrast-checked there). Literal strings so Tailwind generates them.
 */
export const SERVICE_SWATCH: Record<string, string> = {
  stt: 'bg-chart-1',
  'stt-worker': 'bg-chart-3',
  'lm-studio': 'bg-chart-2',
  nlp: 'bg-chart-4',
  tts: 'bg-chart-5',
  gateway: 'bg-primary',
  other: 'bg-secondary-foreground/60',
};
const FALLBACK_SWATCH = 'bg-chart-5';

export const SERVICE_LEGEND_LABEL: Record<string, string> = {
  stt: 'Speech-to-text',
  'stt-worker': 'Batch speech-to-text',
  'lm-studio': 'LM Studio',
  nlp: 'Medical NLP',
  tts: 'Text-to-speech',
  gateway: 'API gateway',
  other: 'Other workloads',
};

/** Diagonal stripes over the swatch: the non-colour cue for an estimate / the unattributed remainder. */
export const HATCH_CLASS = 'bg-[image:repeating-linear-gradient(45deg,transparent_0_3px,var(--background)_3px_5px)]';
export const UNATTRIBUTED_SWATCH = cn('bg-muted-foreground/40', HATCH_CLASS);

export function serviceSwatch(service: string, estimated = false): string {
  const base = SERVICE_SWATCH[service] ?? FALLBACK_SWATCH;
  return estimated ? cn(base, 'opacity-60', HATCH_CLASS) : base;
}

function percentOf(bytes: number, total: number): number {
  return total > 0 ? (bytes / total) * 100 : 0;
}

/** One-sentence summary for `role="img"` (the bar carries no text of its own). */
export function gpuBarSummary(device: ResidencyDevice): string {
  const { title } = splitDeviceLabel(device.label);
  return (
    `${title}: ${formatBytes(device.attributedBytes)} attributed to models, ${formatBytes(device.unattributedBytes)} not attributed, ` +
    `${formatBytes(device.freeBytes)} free; ${formatBytes(device.headroomBytes)} should stay free (headroom line at ${100 - device.headroomPercent}%)`
  );
}

interface BarSegment {
  key: string;
  service: string;
  estimated: boolean;
  width: number;
}

/** Per-model segments then the unattributed remainder, clamped so the stack never exceeds 100%. */
function barSegments(device: ResidencyDevice): BarSegment[] {
  const raw: BarSegment[] = device.models
    .filter((model) => model.bytes !== null && model.bytes > 0)
    .map((model) => ({
      key: `${model.service}::${model.modelRef}`,
      service: model.service,
      estimated: model.bytesSource !== 'measured',
      width: percentOf(model.bytes!, device.totalBytes),
    }));
  if (device.unattributedBytes > 0) {
    raw.push({ key: 'unattributed', service: 'unattributed', estimated: false, width: percentOf(device.unattributedBytes, device.totalBytes) });
  }
  return raw.reduce<{ out: BarSegment[]; left: number }>(
    (acc, segment) => {
      const width = Math.min(segment.width, acc.left);
      return width > 0 ? { out: [...acc.out, { ...segment, width }], left: acc.left - width } : acc;
    },
    { out: [], left: 100 },
  ).out;
}

/**
 * Stacked memory bar (artboard 01, F5): one segment per resident model in its
 * service colour — estimated bytes lighter and striped — then the
 * unattributed remainder (CUDA contexts, other pods), and a dashed marker at
 * `100 − headroomPercent`. Widths are clamped so the stack never exceeds 100%.
 */
export function GpuMemoryBar({ device }: { device: ResidencyDevice }) {
  const segments = barSegments(device);
  return (
    <div role="img" aria-label={gpuBarSummary(device)} className="bg-muted relative h-4 w-full rounded-sm">
      <div className="flex h-full w-full overflow-hidden rounded-sm">
        {segments.map((segment) => (
          <span
            key={segment.key}
            data-slot="gpu-segment"
            data-service={segment.service}
            data-estimated={segment.estimated ? 'true' : 'false'}
            className={cn(
              'h-full',
              segment.service === 'unattributed'
                ? UNATTRIBUTED_SWATCH
                : cn('border-background border-r', serviceSwatch(segment.service, segment.estimated)),
            )}
            style={{ width: `${segment.width}%` }}
          />
        ))}
      </div>
      <span
        aria-hidden
        data-slot="gpu-headroom-marker"
        className="border-destructive absolute -top-1 -bottom-1 border-l-2 border-dashed"
        style={{ left: `${100 - device.headroomPercent}%` }}
      />
    </div>
  );
}
