'use client';

import { IconTerminal2 } from '@tabler/icons-react';
import type { ServiceProbe } from '../api';

/** A not-listening downstream service probes as one of these (vs. `degraded` = up-but-slow). */
const DOWN_STATUSES = new Set(['down', 'unhealthy']);

/**
 * Local-dev diagnosability affordance. When a downstream service
 * probes `down`/`unhealthy` — the tell-tale of a `pnpm dev:*` terminal that
 * failed to bind its port — a lone red card 30s later is the only signal.
 * This points the developer straight at the aggregated probe instead.
 *
 * Hidden in production: `pnpm dev:doctor` is meaningless to a console operator,
 * so the default gate is `NODE_ENV !== 'production'` (overridable for tests).
 */
export function DevServiceDownHint({
    services,
    enabled = process.env.NODE_ENV !== 'production',
}: {
    services: Record<string, ServiceProbe>;
    enabled?: boolean;
}) {
    if (!enabled) return null;

    const down = Object.keys(services).filter((key) => DOWN_STATUSES.has(services[key].status));
    if (down.length === 0) return null;

    const names = down.join(', ');
    const subject = down.length === 1 ? `${names} isn’t responding` : `${names} aren’t responding`;

    return (
        <div
            role="status"
            aria-label="Service not responding"
            className="border-warning/40 bg-warning/10 flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
        >
            <IconTerminal2 aria-hidden className="text-warning-strong mt-0.5 size-4 shrink-0" />
            <div className="flex min-w-0 flex-col gap-0.5">
                <p className="text-foreground">
                    {subject} — if you started services by hand, one may have failed to launch.
                </p>
                <p className="text-muted-foreground">
                    Run <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">pnpm dev:doctor</code> for an
                    aggregated health probe, or <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">pnpm dev:stack</code>{' '}
                    to supervise every service in one place.
                </p>
            </div>
        </div>
    );
}
