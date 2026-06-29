import { Spinner } from '@arcaai/ui/spinner';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode, useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { AppDensityProvider } from '@/providers/density-provider';
import { SDKProvider } from '@/providers/sdk-provider';
import { ThemeProvider } from '@/providers/theme-provider';
import { routeTree } from './routeTree.gen';
import { useAuthStore } from '@/store/auth-store';

const router = createRouter({
    routeTree,
    defaultPreload: 'intent',
    context: { isAuthenticated: false },
});

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}

function Bootstrapping() {
    return (
        <div className="flex h-svh w-full items-center justify-center bg-background">
            <Spinner className="size-8 text-primary" />
        </div>
    );
}

function InnerApp() {
    const hasHydrated = useSyncExternalStore(
        useAuthStore.persist.onFinishHydration,
        () => useAuthStore.persist.hasHydrated(),
        () => false,
    );
    const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

    useEffect(() => {
        return useAuthStore.subscribe((state, prev) => {
            if (prev.isAuthenticated !== state.isAuthenticated) router.invalidate();
        });
    }, []);

    if (!hasHydrated) return <Bootstrapping />;

    return <RouterProvider router={router} context={{ isAuthenticated }} />;
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ThemeProvider>
            <AppDensityProvider>
                <SDKProvider>
                    <InnerApp />
                </SDKProvider>
            </AppDensityProvider>
        </ThemeProvider>
    </StrictMode>,
);
