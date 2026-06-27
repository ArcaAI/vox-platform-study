'use client';

import { Skeleton } from '@/components/shadcn/skeleton';
import { cn } from '@/lib/utils';

export interface DataGridSkeletonProps {
  rows?: number;
  columns?: number;
  className?: string;
}

/** Row skeletons that mirror the loaded grid layout (rule 10). */
export function DataGridSkeleton({ rows = 10, columns = 5, className }: DataGridSkeletonProps) {
  return (
    <div className={cn('flex flex-col gap-2.5 p-3', className)} role="status" aria-label="Loading data">
      <div className="flex items-center gap-3">
        {Array.from({ length: columns }).map((_, c) => (
          <Skeleton key={c} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-3">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-5 flex-1" />
          ))}
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
