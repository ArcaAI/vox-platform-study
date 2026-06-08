import { formatAbsoluteUtc, formatRelativeTime } from '../lib/format';

/**
 * A timestamp rendered as relative time (e.g. `5 minutes ago`) with the exact
 * absolute UTC instant available as a hover tooltip (`11-ux-ui-principles.mdc`
 * §8). Falls back to an absolute local date-time for older timestamps.
 */
export function RelativeTime({ iso, className }: { iso?: string | null; className?: string }) {
  return (
    <span className={className} title={formatAbsoluteUtc(iso)} data-testid="relative-time">
      {formatRelativeTime(iso)}
    </span>
  );
}
