import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/**
 * Segment skeleton mirroring the loaded AI Configuration screen (rule 10):
 * header + tab strip + the effective-models table (9 rows).
 */
export default function AiConfigurationLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex gap-4">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-8 w-36" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 9 }, (_, index) => (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto_auto] items-center gap-4">
            <Skeleton className="h-4 w-32 max-w-full" />
            <Skeleton className="h-4 w-56 max-w-full" />
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
