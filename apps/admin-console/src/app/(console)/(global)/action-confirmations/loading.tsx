import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Mirrors the loaded screen: header, then domain sections of rows with a segmented control. */
export default function ActionConfirmationsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {[4, 3].map((rowCount, section) => (
        <div key={section} className="flex flex-col gap-3">
          <Skeleton className="h-5 w-40" />
          <div className="flex flex-col gap-2 rounded-md border p-3">
            {Array.from({ length: rowCount }, (_, index) => (
              <div key={index} className="flex items-center gap-4">
                <Skeleton className="h-4 w-64" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="ml-auto h-8 w-60 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
