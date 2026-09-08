'use client';

import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useFeatureGates } from './use-feature-gates';
import type { FeatureGateKey } from './keys';

/**
 * Client-side route gate for a platform-wide feature-availability key (rule
 * 13 §Routing). The route pages this wraps stay thin server components —
 * this boundary owns the client fetch, the loading skeleton (rule 10: no
 * spinners/text placeholders) and the 404.
 *
 * Resolution mirrors `visibleNavEntries`'s `gate` handling exactly, so a
 * route and its nav entry can never disagree: while `useFeatureGates()` is
 * loading, nothing is decided yet and the frame holds; once resolved, only
 * `gates[gate] === true` renders the screen — undefined, `false`, and a fetch
 * error/404 all fail closed to `notFound()`. `notFound()` is safe to call
 * from a Client Component render (Next.js catches it the same way it does
 * from a Server Component); it unwinds to the nearest not-found boundary —
 * today that is the root `app/not-found.tsx`, the same precedent
 * `(tenant)/layout.tsx`'s tier guard already uses.
 */
export function FeatureGateBoundary({ gate, children }: { gate: FeatureGateKey; children: ReactNode }) {
  const { gates, isLoading } = useFeatureGates();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-48 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (gates[gate] !== true) {
    notFound();
  }

  return children;
}
