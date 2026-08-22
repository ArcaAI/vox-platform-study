'use client';

import * as React from 'react';
import { cva } from 'class-variance-authority';
import { Minus, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';

import { Card } from '@/components/shadcn/card';
import { Skeleton } from '@/components/shadcn/skeleton';
import type { AsyncStateProps, BaseSurfaceProps } from '@/lib/shared';
import { cn } from '@/lib/utils';

export type StatCardAccent = 'default' | 'primary' | 'ai' | 'success' | 'warning' | 'destructive';
export type DeltaDirection = 'up' | 'down' | 'neutral';
export type DeltaIntent = 'auto' | 'positive' | 'negative' | 'neutral';

export interface StatCardDelta {
  value: number;
  /** Trend arrow + sign. Inferred from `value`'s sign when omitted. */
  direction?: DeltaDirection;
  /** Trailing context, e.g. "this week", "vs 1h". */
  label?: string;
}

export interface StatCardProps extends BaseSurfaceProps, AsyncStateProps {
  label: string;
  /** Rendered with `tabular-nums`. `null`/`''` renders an em-dash. */
  value: React.ReactNode;
  delta?: StatCardDelta;
  /** How to color the delta. `auto`: up=good. `negative`: up=bad (e.g. error rate). */
  deltaIntent?: DeltaIntent;
  icon?: LucideIcon;
  hint?: string;
  accent?: StatCardAccent;
  /** Slot beneath the value+delta, e.g. a sparkline. */
  footer?: React.ReactNode;
  'aria-label'?: string;
}

const statCardVariants = cva('flex flex-col gap-1 border-l-4', {
  variants: {
    accent: {
      default: 'border-l-border',
      primary: 'border-l-primary',
      ai: 'border-l-ai',
      success: 'border-l-success',
      warning: 'border-l-warning',
      destructive: 'border-l-destructive',
    },
    density: { comfortable: 'gap-1 px-5 py-4', compact: 'gap-0.5 px-4 py-3' },
  },
  defaultVariants: { accent: 'default', density: 'comfortable' },
});

const ICON_CHIP: Record<StatCardAccent, string> = {
  default: 'bg-muted text-muted-foreground',
  primary: 'bg-primary/10 text-foreground',
  ai: 'bg-ai/10 text-ai',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  destructive: 'bg-destructive/10 text-destructive',
};

const DELTA_ROLE_CLASS = {
  success: 'text-success',
  destructive: 'text-destructive',
  neutral: 'text-muted-foreground',
} as const;

type DeltaRole = keyof typeof DELTA_ROLE_CLASS;

function resolveDirection(delta: StatCardDelta): DeltaDirection {
  if (delta.direction) return delta.direction;
  if (delta.value > 0) return 'up';
  if (delta.value < 0) return 'down';
  return 'neutral';
}

/** Resolve the delta's semantic color (never raw green/red). `negative` intent inverts which direction is "good". */
function resolveDeltaRole(direction: DeltaDirection, intent: DeltaIntent): DeltaRole {
  if (intent === 'positive') return 'success';
  if (intent === 'neutral' || direction === 'neutral') return 'neutral';
  const upIsGood = intent !== 'negative';
  const isGood = direction === 'up' ? upIsGood : !upIsGood;
  return isGood ? 'success' : 'destructive';
}

const DELTA_ICON: Record<DeltaDirection, LucideIcon> = { up: TrendingUp, down: TrendingDown, neutral: Minus };
const DELTA_SIGN: Record<DeltaDirection, string> = { up: '+', down: '\u2212', neutral: '' };
const DIRECTION_WORD: Record<DeltaDirection, string> = { up: 'up', down: 'down', neutral: 'no change' };

function isEmptyValue(value: React.ReactNode): boolean {
  return value == null || value === '';
}

/**
 * KPI / stat tile (PHASE-2-PLAN §3.2). Semantic accent border + optional icon chip,
 * `tabular-nums` value, and a color-blind-safe delta (trend icon + sign + semantic
 * color resolved by `deltaIntent`). Honors the `AsyncStateProps` loading/empty/error
 * contract and two density modes.
 */
export function StatCard(props: StatCardProps) {
  const {
    label,
    value,
    delta,
    deltaIntent = 'auto',
    icon: Icon,
    hint,
    accent = 'default',
    footer,
    density = 'comfortable',
    className,
    isLoading,
    error,
    emptyState,
    errorState,
    loadingState,
  } = props;

  const wrapperProps = {
    'data-slot': 'stat-card',
    'data-density': density,
    className: cn(statCardVariants({ accent, density }), className),
  } as const;

  if (isLoading) {
    return (
      <Card {...wrapperProps}>
        {loadingState ?? (
          <div role="status" aria-label="Loading" className="flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-3 w-28" />
          </div>
        )}
      </Card>
    );
  }

  if (error) {
    return (
      <Card {...wrapperProps}>
        <span className="text-sm text-muted-foreground">{label}</span>
        {errorState?.(error) ?? <span className="text-sm text-muted-foreground">Unable to load</span>}
      </Card>
    );
  }

  const empty = isEmptyValue(value);
  const direction = delta ? resolveDirection(delta) : null;
  const deltaRole = delta && direction ? resolveDeltaRole(direction, deltaIntent) : null;
  const DeltaIconCmp = direction ? DELTA_ICON[direction] : null;

  const valueText = typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  const ariaLabel =
    props['aria-label'] ??
    [
      label,
      empty ? undefined : valueText,
      delta && direction ? `${DIRECTION_WORD[direction]} ${Math.abs(delta.value)}${delta.label ? ` ${delta.label}` : ''}` : undefined,
    ]
      .filter(Boolean)
      .join(', ');

  return (
    <Card {...wrapperProps} aria-label={ariaLabel}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        {Icon ? (
          <span aria-hidden="true" className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', ICON_CHIP[accent])}>
            <Icon className="size-4" />
          </span>
        ) : null}
      </div>
      <div data-slot="stat-card-value" className="text-2xl leading-tight font-medium tabular-nums text-card-foreground">
        {empty ? '\u2014' : value}
      </div>
      {delta && direction && deltaRole && DeltaIconCmp ? (
        <span
          data-slot="stat-card-delta"
          data-trend={direction}
          className={cn('inline-flex items-center gap-1 text-xs font-medium tabular-nums', DELTA_ROLE_CLASS[deltaRole])}
        >
          <DeltaIconCmp aria-hidden="true" className="size-3.5" />
          <span>
            {DELTA_SIGN[direction]}
            {Math.abs(delta.value)}
          </span>
          {delta.label ? <span className="text-muted-foreground">{delta.label}</span> : null}
        </span>
      ) : null}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      {empty && !hint && emptyState ? emptyState : null}
      {footer ? <div className="mt-2">{footer}</div> : null}
    </Card>
  );
}
