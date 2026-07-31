'use client';

/**
 * "AI Providers" screen (TASK-575, wired into nav under TASK-586 Lane J —
 * the rule-12 design gate was waived by the owner). This is the unified
 * tabbed surface (LLM / STT / TTS) over `admin/providers/:service/:provider`.
 * It coexists with the three existing per-capability screens
 * (`/ai-configuration`, `/stt-config`, `/tts-config`), which stay live and
 * unchanged — see `nav-config.ts` for the known-follow-up note on the
 * credential-tab overlap. See
 * docs/implementation/TASK-575-Unified-AI-Providers-Console/README.md.
 */

import { parseAsString, useQueryState } from 'nuqs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { TenantScopeBanner } from '@/shared/tenant-scope/tenant-scope-banner';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import type { ProviderService } from '../api/types';
import { ProviderCredentialsTab } from './provider-credentials-tab';

const SERVICE_TABS: readonly ProviderService[] = ['llm', 'stt', 'tts'];

const TAB_LABEL: Record<ProviderService, string> = {
  llm: 'LLM',
  stt: 'STT',
  tts: 'TTS',
};

/**
 * Tenant "AI Providers" screen (`/ai-providers`, tier 30-49) — the
 * TASK-575 consolidation of the three per-capability BYO surfaces
 * (`ai-configuration` LLM cards, `stt-config`, `tts-config`) into one
 * service-tabbed screen against the unified `admin/providers/:service` plane
 * (C2/C3, TASK-569/570/571/572). Every tab mutates tenant data, so the
 * "Acting on «Tenant»" banner is pinned for elevated callers on all three
 * (rule 13).
 */
export function AiProvidersScreen() {
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('llm'));
  const tab = (SERVICE_TABS as readonly string[]).includes(tabParam) ? (tabParam as ProviderService) : 'llm';

  return (
    <WorkingTenantGate
      title="AI Providers"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/providers/:service
        </span>
      }
    >
      <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => void setTabParam(next === 'llm' ? null : next)}>
        <ScreenTemplate
          header={<PageHeader title="AI Providers" meta={<span>bring-your-own cloud credentials, one screen per service</span>} />}
          statusBanner={<TenantScopeBanner />}
          tabs={
            <TabsList variant="line">
              {SERVICE_TABS.map((service) => (
                <TabsTrigger key={service} value={service}>
                  {TAB_LABEL[service]}
                </TabsTrigger>
              ))}
            </TabsList>
          }
          footer={
            <StatusFooter
              end={
                <span aria-hidden className="font-mono">
                  credentials: tenant-owned · unified provider plane
                </span>
              }
            />
          }
        >
          {SERVICE_TABS.map((service) => (
            <TabsContent key={service} value={service}>
              <ProviderCredentialsTab service={service} />
            </TabsContent>
          ))}
        </ScreenTemplate>
      </Tabs>
    </WorkingTenantGate>
  );
}
