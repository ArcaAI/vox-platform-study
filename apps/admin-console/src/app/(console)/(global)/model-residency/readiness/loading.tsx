import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Mirrors the readiness screen: header, progress, a checks list and the shadow tiles (rule 10). */
export default function ModelResidencyReadinessLoading() {
  return (
    <div className="flex max-w-3xl flex-col gap-6" aria-hidden>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-4 w-96" />
      </div>
      <Skeleton className="h-2 w-full max-w-xs" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-16" />
        ))}
      </div>
    </div>
  );
}
