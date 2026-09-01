'use client';

import Link from 'next/link';
import { parseAsString, useQueryState } from 'nuqs';
import { IconExternalLink } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { RequirePermission } from '@/shared/auth/require-permission';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { TenantScopeBanner } from '@/shared/tenant-scope/tenant-scope-banner';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { SttFallbackTab } from '@/features/tenant-stt-config/components/stt-fallback-tab';
import { TtsConfigTab } from '@/features/tenant-tts-config/components/tts-config-tab';

const TAB_VALUES = ['speech', 'voice'] as const;

/**
 * Tenant speech &amp; voice configuration (`/ai-configuration`, tier 30-49).
 *
 * ## What TASK-845 took away, and what it deliberately left
 *
 * This screen used to carry four tabs. Two of them — "Models" (the tenant's own
 * `AiTaskDefault` selection) and "Providers" (the BYO credential editor) — were
 * the TENANT HALF of a two-tier cascade whose SYSTEM half lived on a different
 * screen entirely. An administrator comparing a tenant's choice with the
 * platform default it overrides had to navigate between two routes to see two
 * halves of one value. Both moved to `/ai-platform`, where the tier is a
 * control rather than a route.
 *
 * Speech and Voice did NOT move, and that is a judgement rather than an
 * oversight. `TenantSttConfig` and `TenantTtsConfig` are not provider
 * configuration: they are pipeline and voice BINDINGS — which pipeline to run,
 * when to auto-switch, which voice speaks which language. They resolve on their
 * own rows, not on the routing cascade, and folding them into a provider
 * console would recreate exactly the by-which-table grouping TASK-845 exists to
 * remove.
 *
 * The URL is unchanged, so there is no redirect: this is a narrowing, not a
 * rename. The header carries a plain-href link to the surfaces that left, so an
 * administrator who came here looking for them is not left guessing.
 */
export function TenantAiConfigurationScreen() {
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('speech'));
  const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'speech';

  return (
    <WorkingTenantGate
      title="Speech &amp; Voice"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          speech · voice
        </span>
      }
    >
      <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => void setTabParam(next === 'speech' ? null : next)}>
        <ScreenTemplate
          header={
            <PageHeader
              title="Speech &amp; Voice"
              meta={<span>transcription pipeline and voice bindings for this tenant</span>}
              actions={
                <Button asChild variant="outline" size="sm">
                  <Link href="/ai-platform">
                    Providers &amp; models
                    <IconExternalLink aria-hidden />
                  </Link>
                </Button>
              }
            />
          }
          statusBanner={<TenantScopeBanner />}
          tabs={
            <TabsList variant="line">
              <RequirePermission action="read" subject="TenantSttConfig">
                <TabsTrigger value="speech">Speech</TabsTrigger>
              </RequirePermission>
              <RequirePermission action="read" subject="TenantTtsConfig">
                <TabsTrigger value="voice">Voice</TabsTrigger>
              </RequirePermission>
            </TabsList>
          }
          footer={
            <StatusFooter
              end={
                <span aria-hidden className="font-mono">
                  speech + voice: tenant-owned · providers &amp; model selection moved to /ai-platform
                </span>
              }
            />
          }
        >
          <TabsContent value="speech">
            <RequirePermission action="read" subject="TenantSttConfig">
              <SttFallbackTab />
            </RequirePermission>
          </TabsContent>
          <TabsContent value="voice">
            <RequirePermission action="read" subject="TenantTtsConfig">
              <TtsConfigTab />
            </RequirePermission>
          </TabsContent>
        </ScreenTemplate>
      </Tabs>
    </WorkingTenantGate>
  );
}
