import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Mirrors the studio shell: header, caution banner, embed surface (rule 10). */
export default function PstudioLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
      </div>
      <Skeleton className="h-14 w-full rounded-md" />
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-8 w-36" />
      </div>
      <Skeleton className="min-h-[70vh] w-full rounded-md" />
    </div>
  );
}
