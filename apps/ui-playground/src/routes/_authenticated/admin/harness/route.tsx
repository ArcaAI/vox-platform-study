import { createFileRoute, Outlet } from '@tanstack/react-router';
import { RequireAdmin } from '@/components/admin-route-guard';
import { Main } from '@/components/layout/main';
import { HarnessTabs } from '@/features/admin/harness/components/harness-tabs';

/**
 * Layout route for the harness admin console (TASK-330 Phase 6). `RequireAdmin`
 * here guards every child screen (overview/workflows/policy/audit/evals); the
 * platform-only surfaces (global-default policy editor) are gated inside the
 * pages on the `isGlobalScope` ability. The route-based tab bar renders once.
 */
function HarnessLayout() {
  return (
    <RequireAdmin>
      <Main>
        <div className="mb-2">
          <h1 className="text-2xl font-bold tracking-tight">Harness</h1>
          <p className="text-muted-foreground mt-1">
            Administer and observe the clinical documentation harness — workflows, policy, audit, and evals.
          </p>
        </div>
        <HarnessTabs />
        <Outlet />
      </Main>
    </RequireAdmin>
  );
}

export const Route = createFileRoute('/_authenticated/admin/harness')({
  component: HarnessLayout,
});
