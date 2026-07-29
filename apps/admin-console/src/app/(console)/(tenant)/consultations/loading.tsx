import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the consultations screen: header, filter bar, chart card + grid split. */
export default function ConsultationsLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <Skeleton className="h-13 w-full" />
      <div className="grid items-start gap-4 xl:grid-cols-5">
        <div className="flex flex-col gap-3 rounded-md border p-4 xl:col-span-2">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-[240px] w-full" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="flex flex-col gap-3 rounded-md border p-3 xl:col-span-3">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
