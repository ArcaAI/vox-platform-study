'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { Toaster } from '@arcaai/ui/components/shadcn/sonner';

/**
 * BUG-001: next-themes renders its FOUC-prevention <script> inside the React
 * tree, and the React canary bundled with Next 16 warns on every executable
 * <script> created during a client render (upstream: pacocoursey/next-themes#385).
 * The client copy is never executed by React anyway, so mark it as an inert
 * JSON data block there; the SSR copy (which actually runs before first paint)
 * keeps no type. The script carries suppressHydrationWarning, so the
 * server/client attribute difference is tolerated.
 */
const themeScriptProps = typeof window === 'undefined' ? undefined : ({ type: 'application/json' } as const);

export function Providers({ children }: { children: ReactNode }) {
    // One client per browser session; useState keeps it stable across renders.
    const [queryClient] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: {
                        staleTime: 30_000,
                        retry: 1,
                        refetchOnWindowFocus: false,
                    },
                },
            }),
    );

    return (
        <NuqsAdapter>
            <QueryClientProvider client={queryClient}>
                <ThemeProvider
                    attribute="class"
                    defaultTheme="system"
                    enableSystem
                    disableTransitionOnChange
                    scriptProps={themeScriptProps}
                >
                    {children}
                    <Toaster position="bottom-right" />
                </ThemeProvider>
            </QueryClientProvider>
        </NuqsAdapter>
    );
}
