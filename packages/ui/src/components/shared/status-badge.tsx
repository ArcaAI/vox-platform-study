'use client';

import type { ReactNode } from 'react';
import { Badge } from '@/components/shadcn/badge';
import { cn } from '@/lib/utils';

/**
 * Semantic color roles for status, mapped to design-system tokens only
 * (no hardcoded colors). Includes the HOPE roles added in D1.
 */
export type StatusColorRole = 'primary' | 'success' | 'warning' | 'destructive' | 'ai' | 'info' | 'hope' | 'neutral';

/**
 * Tinted roles use the `*-strong` text tokens: the base role colors fall just
 * short of the 4.5:1 WCAG AA ratio for 12px text over their own /10 tint in
 * the light theme (e.g. success 4.11:1). The strong tokens resolve to a darker
 * ramp step in light and to the base role color in dark.
 */
const ROLE_CLASSES: Record<StatusColorRole, string> = {
  primary: 'border-primary/25 bg-primary/10 text-primary-strong',
  success: 'border-success/25 bg-success/10 text-success-strong',
  warning: 'border-warning/30 bg-warning/10 text-warning-strong',
  destructive: 'border-destructive/25 bg-destructive/10 text-destructive-strong',
  ai: 'border-ai/25 bg-ai/10 text-ai',
  info: 'border-info/25 bg-info/10 text-info',
  hope: 'border-hope/30 bg-hope/10 text-hope-strong',
  neutral: 'border-border bg-muted text-muted-foreground',
};

export interface StatusBadgeProps {
  label: ReactNode;
  colorRole?: StatusColorRole;
  /**
   * Optional leading icon element. One icon set per surface (Lucide or Tabler,
   * D2) — the caller passes a rendered icon so this stays icon-library-agnostic.
   */
  icon?: ReactNode;
  className?: string;
}

/**
 * Status indicator that is never color-only: always renders an (optional) icon
 * plus a text label alongside the semantic color.
 */
export function StatusBadge({ label, colorRole = 'neutral', icon, className }: StatusBadgeProps) {
  return (
    <Badge data-slot="status-badge" variant="outline" className={cn('gap-1 font-medium [&_svg]:size-3', ROLE_CLASSES[colorRole], className)}>
      {icon}
      <span>{label}</span>
    </Badge>
  );
}
