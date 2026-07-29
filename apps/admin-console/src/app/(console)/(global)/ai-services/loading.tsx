import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the AI services screen: header + tab strip + two document cards. */
export default function AiServicesLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex items-center gap-4 border-b pb-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-12" />
        <Skeleton className="h-5 w-24" />
      </div>
      {Array.from({ length: 2 }, (_, card) => (
        <div key={card} className="flex flex-col gap-3 rounded-xl border p-4">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-3 w-72 max-w-full" />
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, row) => (
              <div key={row} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-4">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
