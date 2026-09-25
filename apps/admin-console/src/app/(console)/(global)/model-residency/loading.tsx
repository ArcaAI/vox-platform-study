import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Mirrors the catalogue-first residency screen (ticket §13): header, GPU
 *  summary cards, and one card per service with a couple of row placeholders
 *  (rule 10). Matches `CatalogueSkeleton` in `model-residency-screen.tsx`,
 *  which covers the same loading state on a client refetch. */
export default function ModelResidencyLoading() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2 rounded-md border p-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-2 w-full" />
          </div>
        ))}
      </div>
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex flex-col gap-3 rounded-md border p-4">
          <Skeleton className="h-4 w-56" />
          {Array.from({ length: 2 }, (__, row) => (
            <Skeleton key={row} className="h-8 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}
