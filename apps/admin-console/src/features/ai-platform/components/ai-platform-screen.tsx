'use client';

import { useState } from 'react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { IconTransfer } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { RequirePermission } from '@/shared/auth/require-permission';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { CatalogueTab } from './catalogue-tab';
import { ConfigurationTransferDrawer } from './configuration-transfer-drawer';
import { EnginesTab } from './engines-tab';
import { ModelStoreTab } from './model-store-tab';
import { ProvidersTab } from './providers-tab';
import { ScopeControl } from './scope-control';
import { TasksTab } from './tasks-tab';
import { useAiPlatformScope } from './use-ai-platform-scope';

const TAB_VALUES = ['providers', 'tasks', 'catalogue', 'store', 'engines'] as const;
const DEFAULT_TAB = 'providers';

/**
 * AI Platform (`/ai-platform`) — the one screen for managing AI inference
 * providers and configuration (TASK-845).
 *
 * ## What it replaced, and why the merge is not just a tab bar
 *
 * Fourteen routes carried `domain: 'ai-platform'`, carved up by WHICH PRISMA
 * TABLE each one wrote. That is an implementation detail, and it produced two
 * screens for the two tiers of one cascade (`/ai-task-defaults` for SYSTEM,
 * `/ai-configuration` for a tenant) plus a peer screen for the tuning knobs of
 * configurations that lived somewhere else.
 *
 * The tabs here are cut by USER INTENT instead:
 *
 *   * **Providers** — "onboard or change a vendor": its connection, the
 *     configurations that select it, and the runtime knobs that tune it.
 *   * **Tasks** — "what actually serves X?": the elected default and the
 *     already-gated fallback chain, per task key.
 *   * **Catalogue** — "what can a configuration select?"
 *   * **Model store** — "which weights do we hold, and how do we get more?"
 *   * **Engines** — "are the serving engines up?"
 *
 * The merge only works because TASK-844 unified the model underneath: before
 * it, the fallback chain was a string join with nothing to render (program
 * finding F-6), and a "configuration" was not a row you could point at.
 *
 * ## Tier, and why this is a `(shared)` screen
 *
 * Tier 20–29: it renders cross-tenant for a super admin and tenant-scoped for a
 * tenant admin. Tenancy is a CONTROL here, not a route (step 2) — the SYSTEM
 * tier and the working tenant are the two tiers of one cascade, and comparing a
 * value with the value it overrides should not require navigating.
 *
 * Individual surfaces stay gated where the backend gates them: routing-policy
 * writes are SUPER_ADMIN-only and answer 403, which the tabs render as
 * "managed by the platform" rather than as an error.
 */
export function AiPlatformScreen() {
  const scope = useAiPlatformScope();
  const [tabParam, setTabParam] = useQueryState('tab', parseAsStringLiteral(TAB_VALUES).withDefault(DEFAULT_TAB));
  const [transferOpen, setTransferOpen] = useState(false);

  return (
    <Tabs
      className="flex min-h-0 flex-1 flex-col"
      value={tabParam}
      onValueChange={(next) => void setTabParam(next === DEFAULT_TAB ? null : (next as (typeof TAB_VALUES)[number]))}
    >
      <ScreenTemplate
        header={
          <PageHeader
            title="AI Platform"
            meta={<span>providers, task routing, model catalogue, model store &amp; serving engines</span>}
            actions={
              <RequirePermission action="manage" subject="AiRoutingPolicy">
                <Button variant="outline" size="sm" onClick={() => setTransferOpen(true)}>
                  <IconTransfer aria-hidden />
                  Export / import
                </Button>
              </RequirePermission>
            }
          />
        }
        toolbar={<ScopeControl scope={scope} />}
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="providers">Providers</TabsTrigger>
            <TabsTrigger value="tasks">Tasks</TabsTrigger>
            <TabsTrigger value="catalogue">Model catalogue</TabsTrigger>
            <TabsTrigger value="store">Model store</TabsTrigger>
            <TabsTrigger value="engines">Engines</TabsTrigger>
          </TabsList>
        }
        footer={
          <StatusFooter
            start={<span>Scope: {scope.label}</span>}
            end={
              <span aria-hidden className="font-mono">
                tenant → SYSTEM · selection is fail-closed
              </span>
            }
          />
        }
      >
        <TabsContent value="providers">
          <ProvidersTab scope={scope} />
        </TabsContent>
        <TabsContent value="tasks">
          <TasksTab scope={scope} />
        </TabsContent>
        <TabsContent value="catalogue">
          <CatalogueTab enabled={!scope.isLoading} />
        </TabsContent>
        <TabsContent value="store">
          <ModelStoreTab />
        </TabsContent>
        <TabsContent value="engines">
          <EnginesTab enabled={!scope.isLoading} />
        </TabsContent>
      </ScreenTemplate>

      <ConfigurationTransferDrawer open={transferOpen} onOpenChange={setTransferOpen} scope={scope} />
    </Tabs>
  );
}
