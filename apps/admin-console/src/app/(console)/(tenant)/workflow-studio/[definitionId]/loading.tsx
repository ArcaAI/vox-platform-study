import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the studio layout (palette · canvas · inspector) — rule 10, never a
 *  spinner. Widths track the editor's `260px / 1fr / 360px` grid (TASK-893 §3.5). */
export default function WorkflowStudioDefinitionLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-9 w-full" />
      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_360px] gap-4">
        <Skeleton className="h-full w-full" />
        <Skeleton className="h-full w-full" />
        <Skeleton className="h-full w-full" />
      </div>
    </div>
  );
}
