'use client';

import { useId } from 'react';
import { IconShieldLock } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { useSession } from '@/shared/auth';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useGlobalAgenticPolicy, useUpdateGlobalAgenticPolicy } from '../api';
import { AgenticContextTab } from './agentic-context-tab';
import { AgenticPolicyForm } from './agentic-policy-form';
import { LiveEngineTab } from './live-engine-tab';

const TAB_VALUES = ['policy', 'engine', 'context'] as const;

/** Skeleton mirroring the knob group cards (rule 10). */
function PolicyTabSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2" aria-hidden>
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex flex-col gap-3 rounded-xl border p-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56" />
          {Array.from({ length: 3 }, (_, row) => (
            <Skeleton key={row} className="h-8 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Global-default agentic policy tab: the OCC If-Match editor for the loop knobs. */
function GlobalPolicyTab() {
  const uid = useId();
  const policyQuery = useGlobalAgenticPolicy(true);
  const updateMutation = useUpdateGlobalAgenticPolicy();

  if (policyQuery.isPending) return <PolicyTabSkeleton />;
  if (policyQuery.error || !policyQuery.data) {
    return <ErrorState error={policyQuery.error} onRetry={() => void policyQuery.refetch()} />;
  }

  return (
    <section aria-labelledby={`${uid}-global`} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={`${uid}-global`} className="text-base font-semibold">
          Global default agentic loop
        </h2>
        <p className="text-muted-foreground text-sm">
          SYSTEM-tenant GLOBAL-DEFAULT row &mdash; the fallback for every tenant without an override.{' '}
          <span className="font-mono text-xs">PATCH /admin/harness/policy/global</span> with If-Match; drift returns 412 with reload-merge.
        </p>
      </div>
      <AgenticPolicyForm
        policy={policyQuery.data.data}
        etag={policyQuery.data.etag}
        mutation={updateMutation}
        onReloadLatest={() => void policyQuery.refetch()}
      />
    </section>
  );
}

/**
 * Agentic Policy (/agentic-policy, tier 10-19, SUPER_ADMIN only). Edits the
 * platform GLOBAL-DEFAULT agentic-loop knobs + kill-switches (OCC If-Match),
 * flips the engine kill-switch, and documents the `agentic.*` settings
 * registry. Every route here is platform-asserted server-side, so the screen
 * gates the whole surface behind an elevated session (a tenant admin who
 * direct-URLs in sees the not-authorized empty state instead of dead tabs).
 */
export function AgenticPolicyScreen() {
  const session = useSession();
  const isElevated = session.data?.isElevated ?? false;
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('policy'));
  const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'policy';

  if (session.isPending) {
    return (
      <ScreenTemplate header={<PageHeader title="Agentic Policy" />}>
        <PolicyTabSkeleton />
      </ScreenTemplate>
    );
  }

  if (!isElevated) {
    return (
      <ScreenTemplate header={<PageHeader title="Agentic Policy" />}>
        <EmptyState
          icon={IconShieldLock}
          title="Super Admins only"
          description="Agentic policy governs the platform-default agentic loop for every tenant. Only super administrators can view or edit it."
        />
      </ScreenTemplate>
    );
  }

  return (
    <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => void setTabParam(next === 'policy' ? null : next)}>
      <ScreenTemplate
        header={
          <PageHeader
            title="Agentic Policy"
            meta={<span>platform-default agentic loop &middot; every edit appends a HarnessPolicyChange WORM row</span>}
          />
        }
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="policy">Global default</TabsTrigger>
            <TabsTrigger value="engine">Engine kill-switch</TabsTrigger>
            <TabsTrigger value="context">Agentic context</TabsTrigger>
          </TabsList>
        }
        footer={
          <StatusFooter
            end={
              <span aria-hidden className="font-mono">
                GET /admin/harness/policy/global
              </span>
            }
          />
        }
      >
        <TabsContent value="policy">
          <GlobalPolicyTab />
        </TabsContent>
        <TabsContent value="engine">
          <LiveEngineTab />
        </TabsContent>
        <TabsContent value="context">
          <AgenticContextTab />
        </TabsContent>
      </ScreenTemplate>
    </Tabs>
  );
}
