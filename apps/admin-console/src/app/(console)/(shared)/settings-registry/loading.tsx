import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the registry screen: header + toolbar + category groups. */
export default function SettingsRegistryLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-9 w-full max-w-2xl" />
      {Array.from({ length: 3 }, (_, group) => (
        <div key={group} className="flex flex-col gap-2">
          <Skeleton className="h-5 w-40 max-w-full" />
          <div className="flex flex-col gap-2 rounded-md border p-3">
            {Array.from({ length: 4 }, (_, row) => (
              <Skeleton key={row} className="h-8 w-full" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
