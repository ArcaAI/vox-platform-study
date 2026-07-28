import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Route-level fallback mirroring the live-transcription canvas (artboard 4c). */
export default function LiveTranscriptionLoading() {
  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-9 w-64" />
      </div>
      <Skeleton className="h-9 w-72" />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    </div>
  );
}
