import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Mirrors the loaded matrix: header, then two sections of feature rows and cells. */
export default function FeatureAvailabilityLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {[4, 4].map((rowCount, section) => (
        <div key={section} className="flex flex-col gap-3">
          <Skeleton className="h-5 w-40" />
          <div className="flex flex-col gap-2 rounded-md border p-3">
            {Array.from({ length: rowCount }, (_, index) => (
              <div key={index} className="flex items-center gap-4">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="size-8 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
