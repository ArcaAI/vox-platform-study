'use client';

import { cn } from '@/lib/utils';

export interface ListeningPulseProps {
  active?: boolean;
  className?: string;
  label?: string;
}

/** Ambient "listening" dot (reduced-motion → static). */
export function ListeningPulse({ active, className, label }: ListeningPulseProps) {
  return (
    <span data-slot="listening-pulse" data-active={active ? 'true' : undefined} className={cn('inline-flex items-center gap-2', className)}>
      <span className="relative inline-flex size-2.5 items-center justify-center" aria-hidden="true">
        {active ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60 motion-reduce:hidden" /> : null}
        <span className={cn('relative inline-flex size-2.5 rounded-full', active ? 'bg-primary' : 'bg-muted-foreground/40')} />
      </span>
      {label ? <span className="text-xs font-medium text-muted-foreground">{label}</span> : null}
    </span>
  );
}
