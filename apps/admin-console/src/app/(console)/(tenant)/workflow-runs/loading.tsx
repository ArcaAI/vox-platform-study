import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the runs list screen: header, filter bar, fill-height grid. */
export default function WorkflowRunsLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <Skeleton className="h-13 w-full" />
      <div className="flex flex-col gap-2 rounded-md border p-3">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
