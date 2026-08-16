import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the run trace screen: header, status banner, fill-height canvas. */
export default function RunTraceLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-9 w-40" />
      </div>
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-full min-h-96 w-full" />
    </div>
  );
}
