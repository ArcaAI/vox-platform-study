import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Segment loading state — skeletons shaped like the overview's card stack (rule 10). */
export default function DeveloperLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        {[0, 1, 2].map((card) => (
          <div key={card} className="flex flex-col gap-3 rounded-md border p-6">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full max-w-xl" />
            <Skeleton className="h-24 w-full" />
          </div>
        ))}
      </div>
      <Skeleton className="h-8 w-full shrink-0" />
    </div>
  );
}
