import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the three-column editor layout (rail · canvas · inspector) — rule 10,
 *  never a spinner. */
export default function WorkflowStudioDefinitionLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-9 w-full" />
      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr_320px] gap-4">
        <Skeleton className="h-full w-full" />
        <Skeleton className="h-full w-full" />
        <Skeleton className="h-full w-full" />
      </div>
    </div>
  );
}
