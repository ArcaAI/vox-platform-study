'use client';

import type * as React from 'react';

import type { StatusColorRole } from '@/components/shared/status-badge';
import { cn } from '@/lib/utils';

/** Semantic background token per status role (no hardcoded colors). */
const ROLE_BG: Record<StatusColorRole, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  ai: 'bg-ai',
  info: 'bg-info',
  hope: 'bg-hope',
  neutral: 'bg-muted-foreground',
};

const SIZE: Record<'sm' | 'md', string> = {
  sm: 'size-2',
  md: 'size-2.5',
};

export interface StatusDotProps {
  colorRole: StatusColorRole;
  /** Brand "breathing" pulse — disabled under `prefers-reduced-motion`. */
  pulse?: boolean;
  size?: 'sm' | 'md';
  /** When set, an adjacent text label carries the meaning and the dot is decorative. */
  label?: React.ReactNode;
  className?: string;
  /** Standalone accessible name when there is no adjacent label. */
  'aria-label'?: string;
}

/**
 * Semantic status atom (PHASE-2-PLAN A colored dot mapped to a
 * `StatusColorRole` token. It is **never the only status signal** — pass `label`
 * (renders adjacent text, dot decorative) or `aria-label` (standalone, `role="img"`);
 * with neither it is purely decorative (`aria-hidden`). The `pulse` ring respects
 * `prefers-reduced-motion`.
 */
export function StatusDot({ colorRole, pulse = false, size = 'md', label, className, ...props }: StatusDotProps) {
  const ariaLabel = props['aria-label'];
  const bg = ROLE_BG[colorRole];
  const sizeClass = SIZE[size];

  const glyph = (
    <span data-slot="status-dot-glyph" aria-hidden="true" className={cn('relative inline-flex items-center justify-center', sizeClass)}>
      {pulse ? (
        <span
          data-slot="status-dot-pulse"
          className={cn('absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping motion-reduce:hidden', bg)}
        />
      ) : null}
      <span data-slot="status-dot-indicator" className={cn('relative inline-flex rounded-full', sizeClass, bg)} />
    </span>
  );

  if (label != null) {
    return (
      <span data-slot="status-dot" data-color-role={colorRole} data-size={size} className={cn('inline-flex items-center gap-2', className)}>
        {glyph}
        <span className="text-sm text-foreground">{label}</span>
      </span>
    );
  }

  return (
    <span
      data-slot="status-dot"
      data-color-role={colorRole}
      data-size={size}
      className={cn('inline-flex', className)}
      {...(ariaLabel ? { role: 'img', 'aria-label': ariaLabel } : { 'aria-hidden': true })}
    >
      {glyph}
    </span>
  );
}
