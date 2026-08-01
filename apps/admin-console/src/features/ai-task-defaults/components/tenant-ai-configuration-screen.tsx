'use client';

import { parseAsString, useQueryState } from 'nuqs';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { RequirePermission } from '@/shared/auth/require-permission';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { TenantScopeBanner } from '@/shared/tenant-scope/tenant-scope-banner';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { ProviderCredentialsTabs } from '@/features/ai-providers/components/provider-credentials-tabs';
import { SttFallbackTab } from '@/features/tenant-stt-config/components/stt-fallback-tab';
import { TtsConfigTab } from '@/features/tenant-tts-config/components/tts-config-tab';
import { EffectiveHarnessPolicyCard } from './effective-harness-policy-card';
import { EffectiveModelsTable } from './effective-models-table';
import { SmrModelsSection } from './smr-models-section';

const TAB_VALUES = ['models', 'speech', 'voice', 'providers'] as const;

/**
 * Tenant "AI Configuration" hub (`/ai-configuration`, tier 30-49) — TASK-595.
 *
 * The single tenant AI surface: it absorbs the retired standalone screens
 * `/stt-config`, `/tts-config` and `/ai-providers` into four tabs so a tenant
 * admin configures everything AI-related in one place.
 *
 *  - "Models"    — the tenant's OWN summarization selection (SMR primary +
 *    optional fallback, one-action default-provider control) PLUS the
 *    READ-ONLY effective models / HarnessPolicy visibility for the
 *    platform-managed guardrail/nlp/harness keys. Backed by `AiTaskDefault`.
 *  - "Speech"    — the tenant STT fallback spec (pipeline, auto-switch, failure
 *    threshold), OCC-edited. Backed by `TenantSttConfig`.
 *  - "Voice"     — the tenant TTS config (voices, routing, bindings), OCC-edited.
 *    Backed by `TenantTtsConfig`.
 *  - "Providers" — the ONE authoritative bring-your-own credential editor
 *    (LLM / STT / TTS) over the unified provider plane. Backed by `GlobalSetting`.
 *
 * Each tab spans a DIFFERENT backend resource, so every tab (trigger + content)
 * is wrapped in `<RequirePermission action="read" …>` — the nav entry is
 * OR-gated over the four reads, so a user who can read only one resource still
 * reaches the hub and sees only the tab(s) they may read (gateway remains
 * authoritative; this gating is UX-only). Every tab can mutate tenant data, so
 * the "Acting on «Tenant»" banner is always pinned.
 */
export function TenantAiConfigurationScreen() {
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('models'));
  const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'models';

  return (
    <WorkingTenantGate
      title="AI Configuration"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          models · speech · voice · providers
        </span>
      }
    >
      <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => void setTabParam(next === 'models' ? null : next)}>
        <ScreenTemplate
          header={<PageHeader title="AI Configuration" meta={<span>summarization models, speech, voice &amp; bring-your-own cloud credentials</span>} />}
          statusBanner={<TenantScopeBanner />}
          tabs={
            <TabsList variant="line">
              <RequirePermission action="read" subject="AiTaskDefault">
                <TabsTrigger value="models">Models</TabsTrigger>
              </RequirePermission>
              <RequirePermission action="read" subject="TenantSttConfig">
                <TabsTrigger value="speech">Speech</TabsTrigger>
              </RequirePermission>
              <RequirePermission action="read" subject="TenantTtsConfig">
                <TabsTrigger value="voice">Voice</TabsTrigger>
              </RequirePermission>
              <RequirePermission action="read" subject="GlobalSetting">
                <TabsTrigger value="providers">Providers</TabsTrigger>
              </RequirePermission>
            </TabsList>
          }
          footer={
            <StatusFooter
              end={
                <span aria-hidden className="font-mono">
                  smr: tenant-owned · guardrail/nlp/harness: platform-managed · credentials: tenant-owned
                </span>
              }
            />
          }
        >
          <TabsContent value="models" className="flex flex-col gap-6">
            <RequirePermission action="read" subject="AiTaskDefault">
              <SmrModelsSection />
              <Separator />
              <EffectiveModelsTable />
              <EffectiveHarnessPolicyCard />
            </RequirePermission>
          </TabsContent>
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
          <TabsContent value="providers">
            <RequirePermission action="read" subject="GlobalSetting">
              <ProviderCredentialsTabs />
            </RequirePermission>
          </TabsContent>
        </ScreenTemplate>
      </Tabs>
    </WorkingTenantGate>
  );
}
