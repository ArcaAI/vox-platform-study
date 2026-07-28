import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Segment-level skeleton mirroring the content area (rule 10). */
export default function ConsoleLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <Skeleton className="h-8 w-56" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-64 flex-1" />
    </div>
  );
}
