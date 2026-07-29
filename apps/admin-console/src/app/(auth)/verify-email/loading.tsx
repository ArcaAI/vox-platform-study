import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

export default function VerifyEmailLoading() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border p-6">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </main>
  );
}
