import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the Workbench screen: header, toolbar, run panel, node list. */
export default function WorkbenchLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>
      <Skeleton className="h-8 w-full" />
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-9 w-56" />
      </div>
      <Skeleton className="h-9 w-40" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
