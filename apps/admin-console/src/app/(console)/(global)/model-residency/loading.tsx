import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Mirrors the residency screen: header, device/recommendation cards, table rows (rule 10). */
export default function ModelResidencyLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-md border p-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
        </div>
        <div className="flex flex-col gap-2 rounded-md border p-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      </div>
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
