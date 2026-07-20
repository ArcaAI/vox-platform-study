'use client';

import { parseAsString, useQueryState } from 'nuqs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { TenantScopeBanner } from '@/shared/tenant-scope/tenant-scope-banner';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { ByoCredentialCard, CLOUD_PROVIDERS } from './byo-credential-card';
import { EffectiveModelsTable } from './effective-models-table';

const TAB_VALUES = ['effective', 'credentials'] as const;

/** BYO credentials tab: one write-only, OCC-guarded card per cloud provider. */
function CredentialsTab() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Bring your own Azure OpenAI or Amazon Bedrock account. Keys are encrypted at rest via Vault Transit, are never returned by any read, and
        there is no reveal flow. An enabled credential is used for this tenant&apos;s generation requests; a disabled or removed one falls back to
        the platform credentials.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {CLOUD_PROVIDERS.map((meta) => (
          <ByoCredentialCard key={meta.id} meta={meta} />
        ))}
      </div>
    </div>
  );
}

/**
 * TASK-526 — tenant "AI Configuration" screen (/ai-configuration, tier 30-49).
 *
 * Replaces the M-05 dead-end EmptyState that used to live at
 * `/ai-model-defaults`. Two tabs, two different postures:
 *
 *  - "Effective models" — READ-ONLY visibility over all 9 AI task keys (M-11 /
 *    owner expectation E2). Model selection stays a GLOBAL_ADMIN-only write
 *    (expectation E3), so there are deliberately no pickers here; the tenant
 *    sees which model serves each task and which cascade tier decided it.
 *  - "Cloud credentials" — the tenant's OWN write surface (GAP-C1 tenant lane):
 *    BYO Azure/Bedrock endpoints + write-only keys. This tab mutates, so the
 *    "Acting on «Tenant»" banner is pinned for elevated callers (rule 13).
 */
export function TenantAiConfigurationScreen() {
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('effective'));
  const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'effective';

  return (
    <WorkingTenantGate
      title="AI Configuration"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/ai-task-defaults
        </span>
      }
    >
      <Tabs
        className="flex min-h-0 flex-1 flex-col"
        value={tab}
        onValueChange={(next) => void setTabParam(next === 'effective' ? null : next)}
      >
        <ScreenTemplate
          header={<PageHeader title="AI Configuration" meta={<span>effective models &amp; bring-your-own cloud credentials</span>} />}
          // The credentials tab mutates tenant data — name the tenant it acts on.
          statusBanner={tab === 'credentials' ? <TenantScopeBanner /> : undefined}
          tabs={
            <TabsList variant="line">
              <TabsTrigger value="effective">Effective models</TabsTrigger>
              <TabsTrigger value="credentials">Cloud credentials</TabsTrigger>
            </TabsList>
          }
          footer={
            <StatusFooter
              end={
                <span aria-hidden className="font-mono">
                  models: platform-managed · credentials: tenant-owned
                </span>
              }
            />
          }
        >
          <TabsContent value="effective">
            <EffectiveModelsTable />
          </TabsContent>
          <TabsContent value="credentials">
            <CredentialsTab />
          </TabsContent>
        </ScreenTemplate>
      </Tabs>
    </WorkingTenantGate>
  );
}
