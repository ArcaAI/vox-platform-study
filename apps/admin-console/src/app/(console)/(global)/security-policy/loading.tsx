import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Segment loading state — mirrors the two policy cards of the loaded screen. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6 p-4" aria-hidden>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-52" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      {[0, 1].map((card) => (
        <div key={card} className="flex flex-col gap-4 rounded-md border p-4">
          <Skeleton className="h-5 w-48" />
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1, 2, 3].map((field) => (
              <div key={field} className="flex flex-col gap-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
