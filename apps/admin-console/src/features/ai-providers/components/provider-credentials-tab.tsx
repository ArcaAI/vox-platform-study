'use client';

import { IconServerCog } from '@tabler/icons-react';
import { EmptyState } from '@/shared/state/empty-state';
import type { ProviderService } from '../api/types';
import { ProviderCredentialCard } from './provider-credential-card';
import { PROVIDERS_BY_SERVICE } from './provider-meta';

const SERVICE_COPY: Record<ProviderService, string> = {
  llm: 'Bring your own Azure OpenAI, Amazon Bedrock, OpenAI, Anthropic, or Google Vertex AI account for text generation and summarization.',
  stt: 'Bring your own Azure Speech, Sarvam, or OpenAI account for speech-to-text transcription.',
  tts: 'Bring your own Azure Speech or Sarvam account for text-to-speech synthesis.',
  embeddings:
    'Bring your own Azure OpenAI or OpenAI account for embedding generation. This is a separate connection from LLM: a tenant may bring one vendor for generation and another for embeddings.',
  rerank: 'Reranking is served by the platform’s self-hosted TEI service.',
  vector: 'Bring your own Qdrant Cloud cluster for vector storage and retrieval. Without one, the platform’s shared vector plane serves this tenant.',
  'model-registry':
    'Credentials the platform uses to FETCH model weights — a Hugging Face token for gated repos, or an S3/MinIO key pair for a private weight store. Platform-managed: these are set once for every tenant, never per tenant.',
};

/**
 * One service's BYO-credential grid — the shared masked `CredentialCard` set
 * driven by `admin/providers/:service`. Keys are encrypted at rest via Vault
 * Transit, are never returned by any read, and there is no reveal flow. An
 * enabled credential is used for this tenant's requests to that service; a
 * disabled or removed one falls back to the platform credentials.
 *
 * A capability with NO tenant-BYO providers (`rerank`) renders its reason
 * rather than an empty grid. That case is real governance, not a gap: the only
 * reranker is platform infrastructure, so the gateway refuses a tenant row with
 * a 403. Telling the admin that up front is the whole point — the alternative
 * is a blank panel that reads as a broken screen.
 */
export function ProviderCredentialsTab({ service }: { service: ProviderService }) {
  const providers = PROVIDERS_BY_SERVICE[service];

  if (providers.length === 0) {
    return (
      <EmptyState
        icon={IconServerCog}
        title="Platform-managed capability"
        description={`${SERVICE_COPY[service]} There is no cloud provider for a tenant to bring its own account to, so only the platform (SYSTEM) connection serves it — a tenant connection is refused.`}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        {SERVICE_COPY[service]} <span className="font-mono text-xs">PUT /admin/providers/{service}/:provider</span> — write-only, masked on read, OCC
        If-Match.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {providers.map((meta) => (
          <ProviderCredentialCard key={meta.id} service={service} meta={meta} />
        ))}
      </div>
    </div>
  );
}
