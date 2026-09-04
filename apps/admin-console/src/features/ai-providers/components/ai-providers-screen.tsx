'use client';

import { IconExternalLink } from '@tabler/icons-react';
import Link from 'next/link';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { TenantScopeBanner } from '@/shared/tenant-scope/tenant-scope-banner';
import { ProviderCredentialsTabs } from './provider-credentials-tabs';
import { ScopeControl } from './scope-control';
import { UsedByPanel } from './used-by-panel';
import { useProviderScope } from './use-provider-scope';

/**
 * AI Providers (`/ai-providers`, tier 20-29) — THE one screen where a tenant
 * admin brings their own key for a cloud provider (Azure OpenAI / Azure
 * Speech, OpenAI, Anthropic, Bedrock, Vertex, Sarvam, Qdrant, …) and a super
 * admin edits the platform default (SYSTEM) tier. TASK-862 dissolved the
 * five-tab `/ai-platform` hub into this screen: the model catalogue lives on
 * `/ai-models`, engine status on `/ai-services/*`, and task routing moves to
 * the registry's "platform default for task" election (TASK-860) and the
 * Agent (TASK-863).
 *
 * Every `(service, provider)` row shows its tier, whether a key is stored, the
 * endpoint fields, the connection CEILINGS (moved here from the retired runtime
 * profiles), a "Test connection" probe, and the three-state control: *use
 * platform default* (no row) · *bring your own* (enabled + key) · *disabled
 * for this tenant* (a veto that blocks the platform key too).
 *
 * Tenancy is a CONTROL, not a route: the SYSTEM tier and the working tenant
 * are the two tiers of one cascade, and `?tenantId=` parameterises every read
 * and write. The "Acting on" banner marks tenant-tier mutations (rule 12 §5).
 */
export function AiProvidersScreen() {
  const scope = useProviderScope();
  const tenantId = scope.isLoading ? undefined : scope.tenantId;

  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="AI providers"
          meta={<span>bring-your-own vendor keys, endpoints and ceilings — tenant → platform default</span>}
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
      statusBanner={scope.scope === 'tenant' ? <TenantScopeBanner /> : null}
      toolbar={<ScopeControl scope={scope} />}
      footer={
        <StatusFooter
          start={<span>Scope: {scope.label}</span>}
          end={
            <span aria-hidden className="font-mono">
              no row = platform default · enabled + key = yours · disabled = veto
            </span>
          }
        />
      }
    >
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-3" aria-labelledby="provider-connections">
          <div>
            <h2 id="provider-connections" className="text-sm font-medium">
              Connections &amp; credentials
            </h2>
            <p className="text-muted-foreground text-xs">
              Where each vendor lives and how we authenticate to it. A tenant with no connection inherits the platform default; a tenant with its own
              key wins outright; a disabled connection is a veto in both tiers.
            </p>
          </div>
          <ProviderCredentialsTabs tenantId={tenantId} enabled={!scope.isLoading} />
        </section>
        <Separator />
        <UsedByPanel scope={scope} />
      </div>
    </ScreenTemplate>
  );
}
