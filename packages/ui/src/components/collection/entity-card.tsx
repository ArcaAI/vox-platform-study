'use client';

import * as React from 'react';
import { cva } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';

import { Card } from '@/components/shadcn/card';
import { StatusBadge, type StatusColorRole } from '@/components/shared/status-badge';
import type { Density } from '@/lib/shared';
import { cn } from '@/lib/utils';

export interface EntityCardProps {
  title: React.ReactNode;
  icon?: LucideIcon;
  /** Secondary line — e.g. code (mono) + member count. */
  meta?: React.ReactNode;
  status?: { label: string; colorRole: StatusColorRole };
  /** Trailing content row — chips, kebab menu, etc. */
  actions?: React.ReactNode;
  selected?: boolean;
  /** Standalone clickability. Inside `CardGrid` selection is owned by the cell. */
  onClick?: () => void;
  density?: Density;
  className?: string;
}

const entityCardVariants = cva('transition-colors', {
  variants: {
    density: { comfortable: 'gap-3 p-4', compact: 'gap-2 p-3' },
    selected: { true: 'border-ring bg-accent ring-2 ring-ring', false: '' },
    interactive: {
      true: 'cursor-pointer outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring',
      false: '',
    },
  },
  defaultVariants: { density: 'comfortable', selected: false, interactive: false },
});

/**
 * Presentational collection card: icon · title · meta · status,
 * with an optional trailing actions row. Reuses the shadcn `Card` and the
 * canonical `StatusBadge` (status is dot/icon + label, never color-only).
 */
export function EntityCard({
  title,
  icon: Icon,
  meta,
  status,
  actions,
  selected = false,
  onClick,
  density = 'comfortable',
  className,
}: EntityCardProps) {
  const interactive = !!onClick;
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.();
    }
  };

  return (
    <Card
      data-slot="entity-card"
      data-state={selected ? 'selected' : 'default'}
      data-density={density}
      className={cn(entityCardVariants({ density, selected, interactive }), className)}
      {...(interactive ? { role: 'button', tabIndex: 0, onClick, onKeyDown: handleKeyDown } : {})}
    >
      <div className="flex items-start gap-3">
        {Icon ? (
          <span
            aria-hidden="true"
            className={cn(
              'flex shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary',
              density === 'compact' ? 'size-8' : 'size-9',
            )}
          >
            <Icon className="size-4" />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-card-foreground">{title}</div>
          {meta ? <div className="mt-0.5 text-xs text-muted-foreground">{meta}</div> : null}
        </div>
        {status ? <StatusBadge label={status.label} colorRole={status.colorRole} /> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </Card>
  );
}
