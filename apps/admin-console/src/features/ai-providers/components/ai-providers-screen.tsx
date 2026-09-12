'use client';

import { IconBuilding, IconExternalLink, IconWorldCog } from '@tabler/icons-react';
import Link from 'next/link';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { TenantScopeBanner } from '@/shared/tenant-scope/tenant-scope-banner';
import { PlatformProviderSections } from './platform-provider-sections';
import { ProviderCredentialsTabs } from './provider-credentials-tabs';
import { UsedByPanel } from './used-by-panel';
import { useProviderScope, type ResolvedProviderScope } from './use-provider-scope';

/**
 * A STATEMENT of the scope, not a control (TASK-932 R-12).
 *
 * What used to sit here was a two-position tier switch, and it is gone: the
 * shell's working-tenant switcher already answers "whose configuration am I
 * looking at?" for every screen in this console, and a second answer on this one
 * meant the two could disagree. This badge reports the scope the session
 * resolved, and names the control that changes it.
 */
function ScopeSummary({ scope }: { scope: ResolvedProviderScope }) {
  if (scope.isLoading) return <Skeleton className="h-6 w-64" />;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={scope.tier === 'platform' ? 'default' : 'secondary'} className="gap-1.5">
        {scope.tier === 'platform' ? <IconWorldCog aria-hidden className="size-3.5" /> : <IconBuilding aria-hidden className="size-3.5" />}
        <span>{scope.tier === 'platform' ? 'Platform configuration (SYSTEM)' : `Tenant configuration — ${scope.label}`}</span>
      </Badge>
      <span className="text-muted-foreground text-xs">
        {scope.tier === 'platform'
          ? 'Select a working tenant in the top bar to configure that tenant’s own connections instead.'
          : scope.elevated
            ? 'Clear the working tenant in the top bar to configure the platform defaults instead.'
            : 'Your own vendor connections. The platform defaults you inherit are shown read-only under each capability.'}
      </span>
    </div>
  );
}

/**
 * AI Providers (`/ai-providers`) — the ONE screen where provider credentials and
 * endpoints are configured, at whichever tier the working tenant selects.
 *
 * TENANCY IS THE WORKING TENANT (R-12). An elevated administrator with NO
 * working tenant is configuring the PLATFORM: the built-in inference services,
 * the platform's own vendor accounts, and the weight store. Select a tenant in
 * the top bar and the same screen becomes that tenant's own bring-your-own
 * surface, with the "Acting on ‹Tenant›" banner on every mutation. A tenant
 * admin only ever sees the second form — scoped to its OWN tenant, with the
 * platform fallback it inherits shown READ-ONLY under every capability
 * (TASK-954; owner rule: a tenant admin sees and configures its own providers
 * and sees the platform default, read-only).
 *
 * The two views are deliberately NOT the same list. Built-in engines and the
 * model-registry plane are platform infrastructure: the gateway 403s a tenant
 * write and, since TASK-932, 404s a tenant READ, so rendering them under a
 * tenant would be two cards whose every request fails. Conversely the platform
 * view leads with them, because "where is LM Studio's endpoint" was the question
 * this screen could not answer at all.
 */
export function AiProvidersScreen() {
  const scope = useProviderScope();
  const tenantId = scope.isLoading ? undefined : scope.tenantId;

  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="AI providers"
          meta={
            <span>
              {scope.isLoading || scope.tier === 'platform'
                ? 'endpoints, vendor keys and ceilings — built-in services, platform defaults, and each tenant’s own'
                : 'your tenant’s own vendor connections, and the platform defaults you inherit (read-only)'}
            </span>
          }
          actions={
            <Button asChild variant="outline" size="sm">
              <Link href="/ai-models">
                Model registry
                <IconExternalLink aria-hidden />
              </Link>
            </Button>
          }
        />
      }
      statusBanner={scope.tier === 'tenant' ? <TenantScopeBanner /> : null}
      toolbar={<ScopeSummary scope={scope} />}
      footer={
        <StatusFooter
          start={<span>Scope: {scope.label}</span>}
          end={
            <span aria-hidden className="font-mono">
              {scope.tier === 'platform'
                ? 'built-in = platform-run · platform default = inherited on absence'
                : 'no row = platform default · enabled + key = yours · disabled = veto'}
            </span>
          }
        />
      }
    >
      <div className="flex flex-col gap-6">
        {/*
          The session decides WHICH view this is, so nothing is rendered until it
          has hydrated. Defaulting to one of them for a frame showed an elevated
          admin the TENANT screen — "Connections & credentials", tenant wording
          and all — and then swapped it out from under them, which is exactly the
          confusion R-12 removed the tier toggle to prevent.
        */}
        {scope.isLoading ? (
          <div className="flex flex-col gap-4" aria-hidden>
            <Skeleton className="h-5 w-56" />
            <div className="grid gap-4 lg:grid-cols-2">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-64 w-full" />
              ))}
            </div>
          </div>
        ) : scope.tier === 'platform' ? (
          <PlatformProviderSections tenantId={tenantId} enabled={!scope.isLoading} />
        ) : (
          <section className="flex flex-col gap-3" aria-labelledby="provider-connections">
            <div>
              <h2 id="provider-connections" className="text-sm font-medium">
                Connections &amp; credentials
              </h2>
              <p className="text-muted-foreground text-xs">
                Where each vendor lives and how we authenticate to it. A tenant with no connection inherits the platform default (shown read-only
                under each capability); a tenant with its own key wins outright; a disabled connection is a veto in both tiers.
              </p>
            </div>
            <ProviderCredentialsTabs tenantId={tenantId} tier="tenant" enabled={!scope.isLoading} />
          </section>
        )}
        <Separator />
        <UsedByPanel scope={scope} />
      </div>
    </ScreenTemplate>
  );
}
