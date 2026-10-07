import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ModelResidencySkeleton } from '@/features/model-residency/components/model-residency-screen';

/** Route-level loading state (rule 10): the header placeholders plus the SAME
 *  body skeleton the screen shows on a client-side first load — needs
 *  attention, GPU memory cards, the models table and the recommendations rail. */
export default function ModelResidencyLoading() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-52" />
          <div className="flex gap-2">
            <Skeleton className="h-5 w-64 rounded-full" />
            <Skeleton className="h-5 w-56 rounded-full" />
          </div>
        </div>
        <Skeleton className="h-8 w-36" />
      </div>
      <ModelResidencySkeleton />
    </div>
  );
}
