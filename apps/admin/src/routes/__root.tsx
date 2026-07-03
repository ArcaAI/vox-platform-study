import { Button } from '@arcaai/ui/button';
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';
import { Toaster } from 'sonner';

export interface RouterContext {
  isAuthenticated: boolean;
  /** TASK-394 P0-3 — role-aware route guards (defense-in-depth). Mirrors the server RBAC. */
  isSuperAdmin: boolean;
  /** The viewer's own tenant; the redirect target when a guard blocks a non-super-admin. */
  tenantId: string;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  notFoundComponent: NotFound,
  errorComponent: GeneralError,
});

function RootComponent() {
  return (
    <>
      <Outlet />
      <Toaster richColors position="top-right" closeButton />
    </>
  );
}

function CenteredMessage({ code, title, message }: { code: string; title: string; message: string }) {
  return (
    <div className="flex h-svh flex-col items-center justify-center gap-3 bg-background p-6 text-center">
      <p className="font-mono text-5xl font-semibold text-primary">{code}</p>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button asChild className="mt-2">
        <Link to="/">Back to console</Link>
      </Button>
    </div>
  );
}

function NotFound() {
  return <CenteredMessage code="404" title="Not found" message="This page doesn’t exist, or you don’t have access to it." />;
}

function GeneralError({ error }: { error: Error }) {
  return <CenteredMessage code="500" title="Something went wrong" message={error?.message ?? 'An unexpected error occurred.'} />;
}
