'use client';

/**
 * Prompt Instruction Templates (tier 30-49, TASK-634 R6) — the tenant-admin
 * surface for viewing, creating, updating, versioning, diffing and approving
 * the prompts that drive pre-summary and summary generation.
 *
 * Why its own route rather than a tab of `/agents`: the templates and the
 * governance surface were buried two tabs deep inside a screen titled "Agent
 * Catalog", which is why the pre-summary/summary distinction (the actual
 * subject of TASK-634) had nowhere to live. `/agents` now owns exactly one
 * resource — the `DepartmentAgent` catalog — and this screen owns
 * `PromptTemplate` end to end, keeping one authoritative editor per backend
 * resource (rule 13).
 *
 * Tabs:
 *   Fallbacks   — the resolution map: which template is the tenant-wide
 *                 pre-summary, and the department x visit-type summary matrix.
 *   Templates   — the grid + detail slide-over (create / edit / versions /
 *                 diff / test run). Moved verbatim from `/agents`.
 *   Governance  — version history, field-level diff and clinical approval.
 *                 Elevated-only in the console; the server is the authority.
 *
 * Tenant-scoped: a global admin must pick a working tenant before any query
 * mounts (`WorkingTenantGate`); tenant admins pass straight through.
 */

import { useCallback, useState } from 'react';
import { IconPlus } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { useSession } from '@/shared/auth';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { GovernanceTab } from './governance-tab';
import { PromptFallbacksTab } from './prompt-fallbacks-tab';
import { TemplatesTab } from './templates-tab';

type PromptTemplatesScreenTab = 'fallbacks' | 'templates' | 'governance';

/** Which gateway read the footer names, per tab. */
const TAB_ENDPOINT: Record<PromptTemplatesScreenTab, string> = {
  fallbacks: 'GET /admin/prompt-templates + /admin/departments',
  templates: 'GET /admin/prompt-templates',
  governance: 'GET /admin/prompt-templates/:id/versions',
};

function PromptTemplatesScreenBody() {
  // `?tab=governance` is the redirect target from the retired
  // `/prompt-studio`, so the tab stays URL-addressable.
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString);
  const [selectedParam] = useQueryState('template', parseAsString.withDefault(''));
  const session = useSession();
  const isElevated = session.data?.isElevated ?? false;
  const [creating, setCreating] = useState(false);
  const [gridState, setGridState] = useState({ count: 0, loaded: false, refreshing: false });

  // A deep link to a specific template (`?template=`) must land on the tab that
  // can show it, otherwise the drawer opens over the Fallbacks map.
  const requested = tabParam ?? (selectedParam ? 'templates' : null);
  const tab: PromptTemplatesScreenTab =
    isElevated && requested === 'governance' ? 'governance' : requested === 'templates' ? 'templates' : 'fallbacks';

  const handleGridState = useCallback((next: { count: number; loaded: boolean; refreshing: boolean }) => {
    setGridState((previous) =>
      previous.count === next.count && previous.loaded === next.loaded && previous.refreshing === next.refreshing ? previous : next,
    );
  }, []);

  return (
    <Tabs
      className="flex min-h-0 flex-1 flex-col"
      value={tab}
      onValueChange={(next) => void setTabParam(next === 'fallbacks' ? null : next)}
    >
      <ScreenTemplate
        contentMode={tab === 'templates' ? 'fill' : 'scroll'}
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="fallbacks">Fallbacks</TabsTrigger>
            <TabsTrigger value="templates">Templates</TabsTrigger>
            {/* Elevated-only in the console; the 403 is server-side regardless. */}
            {isElevated ? <TabsTrigger value="governance">Governance</TabsTrigger> : null}
          </TabsList>
        }
        header={
          <PageHeader
            title="Prompt Instruction Templates"
            meta={
              tab === 'templates' ? (
                gridState.loaded ? (
                  <span>{formatNumber(gridState.count)} templates</span>
                ) : (
                  <Skeleton className="h-4 w-24" />
                )
              ) : (
                <span>how pre-summary and summary prompts resolve for this tenant</span>
              )
            }
            actions={
              tab === 'templates' ? (
                <Button onClick={() => setCreating(true)}>
                  <IconPlus aria-hidden />
                  New template
                </Button>
              ) : undefined
            }
          />
        }
        footer={
          <StatusFooter
            start={<span>{gridState.refreshing && tab === 'templates' ? 'Refreshing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                {TAB_ENDPOINT[tab]}
              </span>
            }
          />
        }
      >
        <TabsContent value="fallbacks" className="flex min-h-0 flex-1 flex-col">
          <PromptFallbacksTab />
        </TabsContent>
        <TabsContent value="templates" className="flex min-h-0 flex-1 flex-col">
          <TemplatesTab creating={creating} onCreatingChange={setCreating} onCountChange={handleGridState} />
        </TabsContent>
        {isElevated ? (
          <TabsContent value="governance" className="flex min-h-0 flex-1 flex-col">
            <GovernanceTab />
          </TabsContent>
        ) : null}
      </ScreenTemplate>
    </Tabs>
  );
}

export function PromptTemplatesScreen() {
  return (
    <WorkingTenantGate
      title="Prompt Instruction Templates"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/prompt-templates
        </span>
      }
      description="Prompt templates are administered per tenant. Pick a working tenant from the switcher in the top bar to load its templates."
    >
      <PromptTemplatesScreenBody />
    </WorkingTenantGate>
  );
}
