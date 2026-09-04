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
import { TtsConfigTab } from './tts-config-tab';

const TAB_VALUES = ['speech', 'voice'] as const;

/**
 * Tenant speech &amp; voice configuration (`/ai-configuration`, tier 30-49).
 *
 * @deprecated TASK-862 — removed in R4 (with `TenantTtsConfig` / `TenantSttConfig`;
 * the route becomes a one-release `redirect('/agents')` after TASK-861/863 land).
 *
 * TASK-862 relocated this screen out of the deleted `features/ai-task-defaults`
 * (it carried no task-default UI any more — only these two bindings tabs). The
 * `tenant-stt-config` import is the SAME cross-feature edge the screen always
 * had, moved rather than multiplied; both features retire together.
 *
 * `TenantSttConfig` and `TenantTtsConfig` are pipeline and voice BINDINGS —
 * which pipeline to run, when to auto-switch, which voice speaks which
 * language — not provider configuration; the provider keys live on
 * `/ai-providers`, which the header links to.
 */
export function SpeechAndVoiceScreen() {
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
                  <Link href="/ai-providers">
                    Providers &amp; keys
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
                  speech + voice: tenant-owned · deprecated (TASK-862) — replaced by agents · provider keys on /ai-providers
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
