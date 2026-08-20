import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Reference loading state — the sidebar + panel shape Scalar resolves into (rule 10). */
export default function ApiReferenceLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-[32rem] max-w-full" />
      </div>
      <div className="flex min-h-0 flex-1 gap-4">
        <Skeleton className="h-full w-56 shrink-0" />
        <Skeleton className="h-full flex-1" />
      </div>
      <Skeleton className="h-8 w-full shrink-0" />
    </div>
  );
}
