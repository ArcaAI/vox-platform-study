import { Toaster } from 'sonner';
import { GeneralError } from '@/features/errors/general-error';
import { NotFoundError } from '@/features/errors/not-found-error';
import { type QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';

// Exported so the inferred `Route` types in sibling route files (and the
// generated routeTree) can name the root router context across module
// boundaries (otherwise tsc raises TS4023 "cannot be named").
export interface RouterContext {
  queryClient: QueryClient;
  isAuthenticated: boolean;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <>
      <Outlet />
      <Toaster richColors position="top-right" />
    </>
  ),
  notFoundComponent: NotFoundError,
  errorComponent: GeneralError,
});
