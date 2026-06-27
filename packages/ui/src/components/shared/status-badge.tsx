'use client';

import type { ReactNode } from 'react';
import { Badge } from '@/components/shadcn/badge';
import { cn } from '@/lib/utils';

/**
 * Semantic color roles for status, mapped to design-system tokens only
 * (no hardcoded colors). Includes the HOPE roles added in D1.
 */
export type StatusColorRole = 'primary' | 'success' | 'warning' | 'destructive' | 'ai' | 'info' | 'hope' | 'neutral';

const ROLE_CLASSES: Record<StatusColorRole, string> = {
  primary: 'border-primary/25 bg-primary/10 text-primary',
  success: 'border-success/25 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  destructive: 'border-destructive/25 bg-destructive/10 text-destructive',
  ai: 'border-ai/25 bg-ai/10 text-ai',
  info: 'border-info/25 bg-info/10 text-info',
  hope: 'border-hope/30 bg-hope/10 text-hope',
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
 * plus a text label alongside the semantic color (TASK-372 §3.1.3, A3).
 */
export function StatusBadge({ label, colorRole = 'neutral', icon, className }: StatusBadgeProps) {
  return (
    <Badge data-slot="status-badge" variant="outline" className={cn('gap-1 font-medium [&_svg]:size-3', ROLE_CLASSES[colorRole], className)}>
      {icon}
      <span>{label}</span>
    </Badge>
  );
}
