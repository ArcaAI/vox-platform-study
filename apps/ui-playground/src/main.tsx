import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Skeleton } from '@arcaai/ui/skeleton';
import { ErrorBoundary } from './components/error-boundary';
import { ThemeProvider } from './providers/theme-provider';
import { SDKProvider } from './providers/sdk-provider';
import { createAppQueryClient } from './lib/query-client';
import { useAuthStore } from './store/auth-store';
import { routeTree } from './routeTree.gen';
import './index.css';

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  defaultPendingMinMs: 0,
  context: {
    queryClient: undefined!,
    isAuthenticated: false,
  },
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = createAppQueryClient((opts) => router.navigate(opts));

function InnerApp() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return <RouterProvider router={router} context={{ queryClient, isAuthenticated }} />;
}

function App() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const showReactQueryDevtools = import.meta.env.DEV;
  return (
    <StrictMode>
      <ErrorBoundary>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <SDKProvider>
              <Suspense fallback={<AppSkeleton />}>
                <InnerApp />
              </Suspense>
            </SDKProvider>
            {showReactQueryDevtools && <ReactQueryDevtools buttonPosition="bottom-left" />}
          </QueryClientProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}

function AppSkeleton() {
  return (
    <div className="flex h-svh w-full items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Skeleton className="size-12 rounded-xl" />
        <Skeleton className="h-4 w-48" />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
