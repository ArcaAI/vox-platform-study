import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Route-level skeleton mirroring the centered voice-profiles canvas (artboard 4d). */
export default function VoiceProfilesLoading() {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-5 w-44 rounded-full" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="flex flex-col gap-3 rounded-xl border p-4">
        <Skeleton className="h-4 w-44" />
        <div className="flex gap-2">
          <Skeleton className="h-11 w-36" />
          <Skeleton className="h-11 w-28" />
        </div>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
      <div className="flex flex-col gap-3 rounded-xl border p-4">
        <Skeleton className="h-4 w-36" />
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}
