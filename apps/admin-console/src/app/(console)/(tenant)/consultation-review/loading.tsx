import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Segment-scoped skeleton matching the two-pane review layout (rule 10). */
export default function Loading() {
  return (
    <div className="flex flex-col gap-4 p-4" aria-hidden>
      <Skeleton className="h-7 w-56" />
      <div className="grid gap-4 @3xl:grid-cols-2">
        {[0, 1].map((pane) => (
          <div key={pane} className="flex flex-col gap-2 rounded-md border p-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}
