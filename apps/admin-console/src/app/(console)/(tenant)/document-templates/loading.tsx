import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/**
 * Route-level skeleton shaped like the loaded screen (rule 10): the
 * effective-template banner, the catalog heading, then template rows — never a
 * spinner, and never a generic block that reflows into something else.
 */
export default function DocumentTemplatesLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-5 w-64" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  );
}
