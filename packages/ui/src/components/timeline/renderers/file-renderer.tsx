'use client';

import { Download, FileText } from 'lucide-react';

import { buttonVariants } from '@/components/shadcn/button';
import { cn } from '@/lib/utils';

import type { TimelineRendererProps } from '../types';

function formatBytes(bytes?: number): string | null {
  if (bytes == null || Number.isNaN(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)} ${units[unit]}`;
}

/** Generic attachment renderer: icon + name + size + download. */
export function FileRenderer({ content }: TimelineRendererProps) {
  if (content.type !== 'file') return null;
  const size = formatBytes(content.size);
  return (
    <div data-slot="timeline-file" className="flex items-center gap-3 rounded-md border bg-card p-3">
      <FileText className="size-8 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{content.name}</p>
        {size ? <p className="text-xs text-muted-foreground">{size}</p> : null}
      </div>
      <a href={content.url} download className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))} aria-label={`Download ${content.name}`}>
        <Download className="size-4" />
        Download
      </a>
    </div>
  );
}
