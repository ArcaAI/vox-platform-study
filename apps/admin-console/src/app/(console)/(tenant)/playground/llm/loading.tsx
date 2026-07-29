import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the Agent Playground canvas: header, tabs, prompt/output/providers panes. */
export default function PlaygroundLlmLoading() {
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <Skeleton className="h-9 w-72" />
      <div className="grid items-start gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,4fr)_minmax(0,5fr)_minmax(0,3fr)]">
        <div className="flex flex-col gap-3 rounded-xl border p-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
        <div className="flex flex-col gap-3 rounded-xl border p-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-40 w-full" />
        </div>
        <div className="flex flex-col gap-3 rounded-xl border p-4">
          <Skeleton className="h-4 w-40" />
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
