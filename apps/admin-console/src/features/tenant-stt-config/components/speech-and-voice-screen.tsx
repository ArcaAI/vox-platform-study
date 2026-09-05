'use client';

import Link from 'next/link';
import { parseAsString, useQueryState } from 'nuqs';
import { IconExternalLink } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { RequirePermission } from '@/shared/auth/require-permission';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { TenantScopeBanner } from '@/shared/tenant-scope/tenant-scope-banner';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { SttFallbackTab } from './stt-fallback-tab';

const TAB_VALUES = ['speech', 'voice'] as const;

/**
 * Tenant speech &amp; voice configuration (`/ai-configuration`, tier 30-49).
 *
 * @deprecated TASK-862 — removed in R4 with `TenantSttConfig`; the route then
 * becomes a one-release `redirect('/agents')`.
 *
 * TASK-888 retired `TenantTtsConfig` outright, so the screen moved here, into
 * the feature of the one binding it still reads. Its Voice half is no longer a
 * row at all — every field that row carried lives on the TEXT_TO_SPEECH agent
 * or its provider connection — so that tab is now purely the way through to
 * those surfaces. The Speech half is unchanged.
 *
 * `TenantSttConfig` is a pipeline BINDING — which pipeline to run, when to
 * auto-switch — not provider configuration; the provider keys live on
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
              <RequirePermission action="read" subject="Agent">
                <TabsTrigger value="voice">Voice</TabsTrigger>
              </RequirePermission>
            </TabsList>
          }
          footer={
            <StatusFooter
              end={
                <span aria-hidden className="font-mono">
                  speech: tenant-owned · deprecated (TASK-862) — replaced by agents · voice: agent-owned · provider keys on /ai-providers
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
            <RequirePermission action="read" subject="Agent">
              <VoiceMovedToAgentsPanel />
            </RequirePermission>
          </TabsContent>
        </ScreenTemplate>
      </Tabs>
    </WorkingTenantGate>
  );
}

/**
 * Voice tab — the way through to the surfaces that own voice configuration now.
 *
 * TASK-879 made the speech path agent-first and TASK-888 dropped the
 * `TenantTtsConfig` row itself, so there is nothing left to display, let alone
 * edit:
 *
 *   voice / format / speed / sample rate  → the agent's `parameters`
 *   routing chains + allowed providers    → the agent's model chain and the
 *                                           connection rows' three-state `enabled`
 *   voice bindings                        → `AiModel._metadata.voices`
 *
 * The read-only summary of the old row went with the row. The links stay: they
 * are the only reason an admin who knows this screen comes back to it.
 */
function VoiceMovedToAgentsPanel() {
  return (
    <div className="flex flex-col gap-4 py-4">
      <h2 className="text-base font-semibold">Voice settings moved to the text-to-speech agent</h2>
      <Alert>
        <AlertTitle>Retired (TASK-879/888)</AlertTitle>
        <AlertDescription>
          The tenant TTS config row is gone. The voice, format, speed and sample rate are the text-to-speech agent&apos;s{' '}
          <span className="font-mono">parameters</span>; the provider order is the agent&apos;s model chain and its fallback block; which
          engines may serve, and on whose key, is the provider connection.
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href="/agents?task=TEXT_TO_SPEECH">Open text-to-speech agents</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/workflow-studio/assignments">Agent assignments</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/ai-providers">Providers &amp; keys</Link>
        </Button>
      </div>
    </div>
  );
}
