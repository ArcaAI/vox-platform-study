'use client';

import { useState } from 'react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { MonitoringTab } from './monitoring-tab';
import { ParametersTab } from './parameters-tab';
import { PromptsTab } from './prompts-tab';
import { RulesTab } from './rules-tab';

export type GuardrailControlTab = 'rules' | 'prompts' | 'parameters' | 'monitoring';

const FOOTER: Record<GuardrailControlTab, string> = {
  rules: 'Tenant admins switch unlocked checks on/off; actions, caps and locks are platform-only',
  prompts: 'Prompt and mapping saves re-screen; a dry run stores nothing and never loads a model',
  parameters: 'Serving is edited in AI models; load and unload live on Model residency',
  monitoring: 'Cross-tenant, content-free',
};

/** Route-level skeleton: header, tab strip and a generic body (each tab has its own content-shaped one). */
export function GuardrailControlSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex gap-4 border-b pb-2">
        {[0, 1, 2, 3].map((tab) => (
          <Skeleton key={tab} className="h-6 w-24" />
        ))}
      </div>
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-20 w-full" />
      ))}
    </div>
  );
}

/**
 * `/guardrails/control` (TASK-1050 W3c, README §11.3 F) — the platform admin's one guardrail editor:
 * Rules (platform defaults + per-tenant overrides and locks), Prompts (criteria template / native
 * mapping, history, dry run), Parameters (bounded keys, judge model per lane, serving and residency
 * read-only) and Monitoring. Tier 10–19: the `(global)` layout 404s anyone not elevated, and the gateway
 * 403s anyone not SUPER_ADMIN in a tenant-less context.
 */
export function GuardrailControlScreen({ initialTab = 'rules' }: { initialTab?: GuardrailControlTab }) {
  const [tab, setTab] = useState<GuardrailControlTab>(initialTab);
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as GuardrailControlTab)}>
      <ScreenTemplate
        header={
          <PageHeader
            title="Guardrail control"
            meta={
              <>
                <span>Platform-wide guardrail rules, judge prompts, parameters and monitoring.</span>
                <Badge variant="outline" className="font-mono text-xs">
                  admin/guardrail/*
                </Badge>
              </>
            }
          />
        }
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="rules">Rules</TabsTrigger>
            <TabsTrigger value="prompts">Prompts</TabsTrigger>
            <TabsTrigger value="parameters">Parameters</TabsTrigger>
            <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
          </TabsList>
        }
        footer={<StatusFooter start={FOOTER[tab]} />}
      >
        <TabsContent value="rules">
          <RulesTab />
        </TabsContent>
        <TabsContent value="prompts">
          <PromptsTab />
        </TabsContent>
        <TabsContent value="parameters">
          <ParametersTab />
        </TabsContent>
        <TabsContent value="monitoring">
          <MonitoringTab />
        </TabsContent>
      </ScreenTemplate>
    </Tabs>
  );
}
