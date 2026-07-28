import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Mirrors the loaded profile layout: header, identity grid, entitlement cards, config rows. */
export default function TenantProfileLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="bg-card rounded-xl border p-6">
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-5 w-40 max-w-full" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-40" />
        ))}
      </div>
      <div className="flex flex-col gap-2 rounded-md border p-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
