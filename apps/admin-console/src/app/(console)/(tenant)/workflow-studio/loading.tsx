import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the studio layout (palette · canvas · inspector) — rule 10, never a
 *  spinner. `/workflow-studio` resolves straight into the editor, so the list-shaped skeleton
 *  this file used to carry would flash the wrong shape (TASK-893 OD-1). */
export default function WorkflowStudioLoading() {
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
