import { cn } from '@/lib/utils';
import { confidencePercent } from '@arcaai/vox';

interface ConfidenceIndicatorProps {
  /** Model/sensor confidence in the claim, 0–1. */
  confidence: number;
  className?: string;
}

// Colour the bar by confidence band so low-confidence claims read as cautionary
// even at a glance (independent of the verification status badge).
function barColor(percent: number): string {
  if (percent >= 80) return 'bg-emerald-500';
  if (percent >= 50) return 'bg-amber-500';
  return 'bg-red-500';
}

export function ConfidenceIndicator({ confidence, className }: ConfidenceIndicatorProps) {
  const percent = confidencePercent(confidence);
  return (
    <div className={cn('flex items-center gap-1.5', className)} title={`Confidence ${percent}%`} data-confidence={percent}>
      <div
        className="bg-muted h-1.5 w-12 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={cn('h-full rounded-full transition-all', barColor(percent))} style={{ width: `${percent}%` }} />
      </div>
      <span className="text-muted-foreground tabular-nums text-[10px]">{percent}%</span>
    </div>
  );
}
