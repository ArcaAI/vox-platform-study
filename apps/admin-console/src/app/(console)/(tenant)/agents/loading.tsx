import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/**
 * TASK-965 (AG-23) — the route had no `loading.tsx`, so navigating to `/agents` showed the
 * previous screen until the client bundle and the first read resolved. This mirrors the loaded
 * frame: pinned header (title + actions), the grid's header row and rows, and the status footer.
 * Rule 10 — a skeleton shaped like the content it replaces, never a spinner.
 */
export default function AgentsLoading() {
  return (
    <div className="flex h-full flex-col gap-4 p-4" aria-hidden>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      <Skeleton className="h-9 w-full max-w-md" />
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <Skeleton className="h-9 w-full" />
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
      <Skeleton className="h-6 w-full" />
    </div>
  );
}
