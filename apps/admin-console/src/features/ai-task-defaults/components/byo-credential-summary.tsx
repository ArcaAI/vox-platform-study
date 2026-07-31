'use client';

import { useId } from 'react';
import { IconExternalLink } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ErrorState } from '@/shared/state/error-state';
import { useProviderConnection } from '../api/providers-hooks';
import type { CloudByoProvider } from '../api/providers-types';

/** LLM BYO providers, in display order (mirrors `CLOUD_BYO_PROVIDERS`). */
export const LLM_BYO_PROVIDERS = [
  { id: 'azure', label: 'Azure OpenAI' },
  { id: 'bedrock', label: 'Amazon Bedrock' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'vertex', label: 'Google Vertex AI' },
] as const satisfies readonly { id: CloudByoProvider; label: string }[];

/** One provider's read-only status row: Configured/None + enabled, from the masked read. */
function ProviderStatusRow({ provider, label }: { provider: CloudByoProvider; label: string }) {
  const query = useProviderConnection(provider);

  if (query.isPending) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3" aria-hidden>
        <Skeleton className="h-4 w-32 max-w-full" />
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
    );
  }
  if (query.error || !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const current = query.data.data;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3">
      <span className="text-sm font-medium">{label}</span>
      {current.hasKey ? (
        <Badge variant="default">configured{current.keyVersion != null ? ` · v${current.keyVersion}` : ''}</Badge>
      ) : (
        <Badge variant="outline">not configured</Badge>
      )}
      <Badge variant={current.enabled ? 'secondary' : 'outline'}>{current.enabled ? 'enabled' : 'disabled'}</Badge>
    </div>
  );
}

/**
 * Read-only summary of this tenant's BYO LLM cloud credentials (TASK-592).
 *
 * `/ai-providers` is the ONE authoritative editor for BYO credentials (rule 13:
 * one authoritative editor per resource). This tab used to host a second,
 * duplicate editor; it is now demoted to a masked status summary
 * (Configured/None + enabled, never any key material) plus a plain-href deep
 * link to `/ai-providers` for the actual edits.
 */
export function ByoCredentialSummary() {
  const uid = useId();
  return (
    <section aria-labelledby={`${uid}-title`} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={`${uid}-title`} className="text-base font-semibold">
          Cloud credentials ({LLM_BYO_PROVIDERS.length})
        </h2>
        <p className="text-muted-foreground text-sm">
          Bring-your-own Azure OpenAI, Amazon Bedrock, OpenAI, Anthropic or Google Vertex AI accounts are managed on the AI Providers screen. This is a
          read-only status view &mdash; keys are never returned by any read. An enabled credential is used for this tenant&apos;s generation requests; a
          disabled or absent one falls back to the platform credentials.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {LLM_BYO_PROVIDERS.map((meta) => (
          <ProviderStatusRow key={meta.id} provider={meta.id} label={meta.label} />
        ))}
      </div>
      <div className="flex justify-end">
        {/* Plain href (rule 13 isolation) — `/ai-providers` owns the BYO-credential write. */}
        <Button variant="outline" size="sm" asChild>
          <a href="/ai-providers">
            <IconExternalLink aria-hidden />
            Manage credentials in AI Providers
          </a>
        </Button>
      </div>
    </section>
  );
}
