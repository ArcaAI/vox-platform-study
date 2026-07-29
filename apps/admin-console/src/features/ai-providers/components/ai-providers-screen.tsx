'use client';

/**
 * ⚠️ DESIGN GATE OPEN (rule 12) — DO NOT MERGE TO NAV until an approved
 * Figma frame or recorded owner waiver exists.
 *
 * This screen (TASK-575) is built and tested but deliberately in a
 * NON-WIRED posture: it is not linked from `nav-config.ts`, and the three
 * existing screens it would eventually consolidate (`/ai-configuration`,
 * `/stt-config`, `/tts-config`) are untouched and keep serving traffic. See
 * docs/implementation/TASK-575-Unified-AI-Providers-Console/README.md.
 */

import { IconAlertTriangle } from '@tabler/icons-react';
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
 * Persistent rule-12 design-gate notice, pinned at the top of the page via
 * `ScreenTemplate`'s `statusBanner` slot — see the file header comment for
 * the full posture.
 */
function DesignGateBanner() {
  return (
    <div role="status" className="bg-warning/10 text-foreground flex items-center gap-2 px-4 py-1.5 text-sm">
      <IconAlertTriangle aria-hidden className="text-warning size-4 shrink-0" />
      <span className="min-w-0">
        <strong className="font-medium">DESIGN GATE OPEN (rule 12)</strong> — DO NOT MERGE TO NAV until an approved Figma frame or recorded owner
        waiver exists.
      </span>
    </div>
  );
}

/**
 * Tenant "AI Providers" screen (`/ai-providers`, tier 30-49) — the optional
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
          statusBanner={
            <div className="flex flex-col gap-2">
              <DesignGateBanner />
              <TenantScopeBanner />
            </div>
          }
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
