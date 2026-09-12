'use client';

import { IconServerCog } from '@tabler/icons-react';
import { EmptyState } from '@/shared/state/empty-state';
import { usePlatformDefaults, useProviderConnections } from '../api/hooks';
import { declarableService, type ProviderService } from '../api/types';
import { PlatformDefaultsPanel } from './platform-defaults-panel';
import { ProviderConnectionGroup } from './provider-connection-group';
import { ProviderCredentialCard } from './provider-credential-card';
import { cloudProvidersFor } from './provider-meta';
import type { ProviderTier } from './use-provider-scope';

const SERVICE_COPY: Record<ProviderService, string> = {
  llm: 'Bring your own Azure OpenAI, Amazon Bedrock, OpenAI, Anthropic, or Google Vertex AI account for text generation and summarization.',
  stt: 'Bring your own Azure Speech, Azure AI Foundry, Sarvam, or OpenAI account for speech-to-text transcription.',
  tts: 'Bring your own Azure Speech or Sarvam account for text-to-speech synthesis.',
  embeddings:
    'Bring your own Azure OpenAI or OpenAI account for embedding generation. This is a separate connection from text generation: a tenant may bring one vendor for generation and another for embeddings.',
  rerank: 'Reranking is served by the platform’s self-hosted TEI service.',
  vector: 'Bring your own Qdrant Cloud cluster for vector storage and retrieval. Without one, the platform’s shared vector plane serves this tenant.',
  'model-registry':
    'Credentials the platform uses to FETCH model weights — a Hugging Face token for gated repos, or an S3/MinIO key pair for a private weight store. Platform-managed: these are set once for every tenant, never per tenant.',
};

/**
 * One service's credential grid — one card per provider visible to the tier,
 * driven by `admin/providers/:service`. Keys are encrypted at rest via Vault
 * Transit, are never returned by any read, and there is no reveal flow.
 *
 * A capability with NO providers for this tier renders its reason rather than an
 * empty grid. On the TENANT tier that is a real case (`rerank` has no cloud
 * vendor to bring an account to, and the whole `model-registry` plane is
 * platform infrastructure) — though since TASK-932 the tab bar drops those
 * services entirely, so this branch is the belt rather than the braces.
 */
export function ProviderCredentialsTab({
  service,
  tenantId,
  tier = 'tenant',
  enabled = true,
}: {
  service: ProviderService;
  tenantId?: string;
  tier?: ProviderTier;
  enabled?: boolean;
}) {
  const providers = cloudProvidersFor(service);
  // TASK-954 — the platform fallback this tenant inherits, read ONCE per tab
  // and shared between the read-only panel and every card's hint. Never on the
  // platform tier: the SYSTEM tenant is the top of the cascade (the route 400s).
  const tenantTier = tier === 'tenant';
  const platformDefaults = usePlatformDefaults(service, tenantId, enabled && tenantTier && providers.length > 0);
  /**
   * TASK-958 D-9 — multiplicity is for the capabilities a tenant can DECLARE
   * MODELS on (`llm | stt | tts`). `embeddings` / `vector` keep exactly one card
   * per provider: the gateway refuses a non-default row there
   * (`CONNECTION_MULTIPLICITY_UNSUPPORTED`), and an "add another" button whose
   * every use is a 400 is worse than no button. The SYSTEM tier is likewise
   * one row per provider, so the platform tab is untouched.
   */
  const multiConnection = tenantTier && declarableService(service);
  // One list read per TAB, shared by every group on it — a per-group read would
  // be five identical requests for one array.
  const connections = useProviderConnections(service, tenantId, enabled && multiConnection && providers.length > 0);

  if (providers.length === 0) {
    return (
      <EmptyState
        icon={IconServerCog}
        title="Platform-managed capability"
        description={`${SERVICE_COPY[service]} There is no cloud provider for a tenant to bring its own account to, so only the platform connection serves it — a tenant connection is refused.`}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        {SERVICE_COPY[service]} <span className="font-mono text-xs">PUT /admin/providers/{service}/:slug</span> — write-only, masked on read, OCC
        If-Match.
      </p>
      {tenantTier ? <PlatformDefaultsPanel service={service} query={platformDefaults} /> : null}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {providers.map((meta) => {
          const platformDefault = tenantTier ? platformDefaults.data?.connections.find((connection) => connection.provider === meta.id) : undefined;
          return multiConnection ? (
            <ProviderConnectionGroup
              key={meta.id}
              service={service}
              meta={meta}
              tenantId={tenantId}
              enabled={enabled}
              platformDefault={platformDefault}
              connections={connections}
            />
          ) : (
            <ProviderCredentialCard
              key={meta.id}
              service={service}
              meta={meta}
              tenantId={tenantId}
              tier={tier}
              enabled={enabled}
              platformDefault={platformDefault}
            />
          );
        })}
      </div>
    </div>
  );
}
