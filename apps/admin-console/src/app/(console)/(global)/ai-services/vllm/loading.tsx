import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the engine screen: header, four stat tiles, tab strip, list. */
export default function EngineLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-20 w-full" />
        ))}
      </div>
      <div className="flex items-center gap-4 border-b pb-2">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-5 w-28" />
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-56 max-w-full" />
              <Skeleton className="h-5 w-40 rounded-full" />
            </div>
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
