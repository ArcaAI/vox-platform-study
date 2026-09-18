'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { Toaster } from '@arcaai/ui/components/shadcn/sonner';
import { retryQuery } from '@/shared/api';
import { useSessionHeartbeat } from '@/shared/auth/hooks';
import type { SafeSession } from '@/server/safe-user';

/**
 * Next-themes renders its FOUC-prevention <script> inside the React
 * tree, and the React canary bundled with Next 16 warns on every executable
 * <script> created during a client render (upstream: pacocoursey/next-themes#385).
 * The client copy is never executed by React anyway, so mark it as an inert
 * JSON data block there; the SSR copy (which actually runs before first paint)
 * keeps no type. The script carries suppressHydrationWarning, so the
 * server/client attribute difference is tolerated.
 */
const themeScriptProps = typeof window === 'undefined' ? undefined : ({ type: 'application/json' } as const);

export function Providers({ children, session }: { children: ReactNode; session?: SafeSession }) {
  // Rotate ahead of the access token's TTL. Mounted here because Providers
  // wraps the console and nothing else, so it never runs pre-session.
  useSessionHeartbeat();

  // One client per browser session; useState keeps it stable across renders.
  // Runs on the server render AND the client render, so seeding the cache
  // here (rather than in an effect) makes both agree on the very first
  // paint — see the F-035 seeding note below.
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          // One retry for transient failures only — a 4xx is
          // deterministic and must not be replayed.
          retry: retryQuery,
          refetchOnWindowFocus: false,
        },
      },
    });

    // F-035: the console layout already decrypts the session server-side
    // (`getSession()`); seed `['auth','session']` from it so the SSR pass
    // and the first client render both read the same data instead of the
    // server rendering a `session.data === undefined` gate branch while
    // the client's `/api/auth/session` fetch races hydration. Also saves
    // a redundant fetch per page load.
    if (session) {
      client.setQueryData(['auth', 'session'], session);
    }

    return client;
  });

  return (
    <NuqsAdapter>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange scriptProps={themeScriptProps}>
          {children}
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </QueryClientProvider>
    </NuqsAdapter>
  );
}
