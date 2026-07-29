'use client';

import type { ProviderService } from '../api/types';
import { ProviderCredentialCard } from './provider-credential-card';
import { PROVIDERS_BY_SERVICE } from './provider-meta';

const SERVICE_COPY: Record<ProviderService, string> = {
  llm: 'Bring your own Azure OpenAI, Amazon Bedrock, OpenAI, Anthropic, or Google Vertex AI account for text generation and summarization.',
  stt: 'Bring your own Azure Speech, Sarvam, or OpenAI account for speech-to-text transcription.',
  tts: 'Bring your own Azure Speech or Sarvam account for text-to-speech synthesis.',
};

/**
 * One service's BYO-credential grid — the shared masked `CredentialCard` set
 * driven by `admin/providers/:service`. Keys are encrypted at rest via Vault
 * Transit, are never returned by any read, and there is no reveal flow. An
 * enabled credential is used for this tenant's requests to that service; a
 * disabled or removed one falls back to the platform credentials.
 */
export function ProviderCredentialsTab({ service }: { service: ProviderService }) {
  const providers = PROVIDERS_BY_SERVICE[service];
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
