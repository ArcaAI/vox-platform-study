'use client';

import { parseAsString, useQueryState } from 'nuqs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { TenantScopeBanner } from '@/shared/tenant-scope/tenant-scope-banner';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { ByoCredentialSummary } from './byo-credential-summary';
import { EffectiveHarnessPolicyCard } from './effective-harness-policy-card';
import { EffectiveModelsTable } from './effective-models-table';
import { PlatformManagedTextGenSummary } from './platform-managed-textgen-summary';
import { SmrModelsSection } from './smr-models-section';

const TAB_VALUES = ['effective', 'smr', 'credentials'] as const;

/** Tabs whose content mutates tenant data — they pin the "Acting on «Tenant»" banner. */
const MUTATING_TABS = new Set<string>(['smr']);

/**
 * Tenant "AI Configuration" screen (/ai-configuration, tier 30-49).
 *
 * Replaces the dead-end EmptyState that used to live at
 * `/ai-model-defaults`. Three tabs, three postures:
 *
 *  - "Effective models" — READ-ONLY visibility over the guardrail/nlp/harness
 *    task keys, PLUS (TASK-547 requirement 4 / OD-2) the effective HarnessPolicy
 *    knobs with a per-key "who controls this" label. Selection for these tasks
 *    stays a GLOBAL_ADMIN-only write and HarnessPolicy's tenant-tier knobs are
 *    edited from `/harness/policy` (the one authoritative editor, rule 13) —
 *    there are deliberately no pickers or save controls here; the tenant
 *    sees which model/value serves each task and which tier decided it.
 *  - "SMR models" — the tenant's OWN text-generation selection (TASK-588/592): a
 *    one-action default provider control over the tenant-editable text-gen keys,
 *    the primary + optional fallback per-key cards, and a read-only summary of
 *    the platform-locked (guardrail/nlp/harness) text-gen selections. Saved with
 *    OCC, CLS-pinned to the working tenant. This tab mutates, so the "Acting on
 *    «Tenant»" banner is pinned.
 *  - "Cloud credentials" — a READ-ONLY status summary of the tenant's BYO LLM
 *    credentials (TASK-592). `/ai-providers` is the one authoritative editor
 *    (rule 13); this tab was demoted from a duplicate editor to a masked
 *    Configured/None summary + a deep link, so it no longer mutates.
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
      <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => void setTabParam(next === 'effective' ? null : next)}>
        <ScreenTemplate
          header={<PageHeader title="AI Configuration" meta={<span>effective models, summarization selection &amp; bring-your-own cloud credentials</span>} />}
          // The SMR and credentials tabs mutate tenant data — name the tenant they act on.
          statusBanner={MUTATING_TABS.has(tab) ? <TenantScopeBanner /> : undefined}
          tabs={
            <TabsList variant="line">
              <TabsTrigger value="effective">Effective models</TabsTrigger>
              <TabsTrigger value="smr">SMR models</TabsTrigger>
              <TabsTrigger value="credentials">Cloud credentials</TabsTrigger>
            </TabsList>
          }
          footer={
            <StatusFooter
              end={
                <span aria-hidden className="font-mono">
                  guardrail/nlp/harness: platform-managed · smr: tenant-owned · credentials: managed in AI Providers
                </span>
              }
            />
          }
        >
          <TabsContent value="effective" className="flex flex-col gap-6">
            <EffectiveModelsTable />
            <EffectiveHarnessPolicyCard />
          </TabsContent>
          <TabsContent value="smr" className="flex flex-col gap-6">
            <SmrModelsSection />
            <PlatformManagedTextGenSummary />
          </TabsContent>
          <TabsContent value="credentials">
            <ByoCredentialSummary />
          </TabsContent>
        </ScreenTemplate>
      </Tabs>
    </WorkingTenantGate>
  );
}
