import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Mirrors the queues list: header, filter strip, table rows (rule 10). */
export default function QueuesLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-[54px] w-full rounded-md" />
      <div className="flex flex-col overflow-hidden rounded-md border">
        <div className="bg-muted/50 border-b p-3">
          <Skeleton className="h-4 w-2/3" />
        </div>
        <div className="flex flex-col gap-4 p-4">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-5 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
