import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the Consumption & Cost screen: header + KPI strip + chart/table cards. */
export default function ConsumptionCostLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2 rounded-xl border p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="rounded-xl border p-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-[240px] w-full" />
        </div>
        <div className="rounded-xl border p-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-[200px] w-full" />
        </div>
      </div>
      <div className="rounded-xl border p-6">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-4 h-40 w-full" />
      </div>
    </div>
  );
}
