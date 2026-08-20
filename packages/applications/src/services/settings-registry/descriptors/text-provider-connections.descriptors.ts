// TEXT cloud-provider CONNECTION config — tier `env`.
//
// The three cloud LLM providers (OpenAI / Anthropic / Google
// Vertex) each carry a small PLATFORM-level connection surface in
// `apps/text/src/text/core/config.py` (`OpenAIConfig` / `AnthropicConfig` /
// `VertexConfig`, `TEXT_OPENAI_` / `TEXT_ANTHROPIC_` / `TEXT_VERTEX_` prefixes).
// These are NON-SECRET platform routing values (base URL / endpoint / deployment
// / tuning) used when a tenant has no enabled BYO connection for the provider —
// the per-tenant key/endpoint is a different data class entirely
// (`AiProviderConnection`, `db-secret` Vault-Transit ciphertext).
//
// FIELD SEMANTICS FOR THIS TIER (identical to `bootstrap-env.descriptors.ts`):
//   - tier `env`            supplied through the process environment; read by
//                           `apps/text` (pydantic-settings), never by the gateway.
//   - `editableBy: none`    no admin write path for a deploy-time value; a
//                           governance test binds `tier === 'env'` ⟺ `none`.
//   - `failMode`            DECLARATIVE, not behavioural (env is not a control
//                           plane): `open-to-default` — the reader has a code
//                           fallback, transcribed verbatim into `default`.
//   - `default`            the TEXT config class's ACTUAL fallback (config.py).
//
// The CREDENTIALS themselves (`TEXT_OPENAI_API_KEY`,
// `TEXT_ANTHROPIC_API_KEY`, `TEXT_AZURE_API_KEY`) are BYOK-only and NO LONGER
// registered anywhere — they are `db-secret` (Vault-Transit ciphertext in
// `AiProviderConnection`, with the SYSTEM row as the platform default), never an
// env var. Only the non-secret routing below stays `env`-tier. Vertex
// authenticates with a service-account JSON (tenant BYO) or Application Default
// Credentials (platform), so it has no `TEXT_VERTEX_API_KEY`.

import { EDITABLE_BY_NONE, SettingDescriptor } from '../registry.types';

/** Shared shape for an TEXT cloud-provider connection-config variable. */
function textProviderEnv(key: string, label: string, description: string, defaultValue?: unknown): SettingDescriptor {
  return {
    key,
    tier: 'env',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: EDITABLE_BY_NONE,
    failMode: 'open-to-default',
    category: 'AI Providers',
    label,
    description,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

export const TEXT_PROVIDER_CONNECTION_SETTINGS: SettingDescriptor[] = [
  // ── OpenAI (TEXT_OPENAI_) ──────────────────────────────────────────────────
  textProviderEnv(
    'textOpenai.baseUrl',
    'TEXT OpenAI base URL',
    'OpenAI API base URL for TEXT’s platform-fallback OpenAI client (`OpenAIConfig.base_url`). Override for an OpenAI-compatible gateway; a tenant BYO connection may override it per request.',
    'https://api.openai.com/v1',
  ),
  textProviderEnv(
    'textOpenai.organization',
    'TEXT OpenAI organization',
    'Optional OpenAI organization id sent by TEXT’s platform-fallback client (`OpenAIConfig.organization`). Unset ⇒ the account default organization.',
  ),
  textProviderEnv(
    'textOpenai.defaultModel',
    'TEXT OpenAI default model',
    'Empty by design (TASK-579): provider/model SELECTION is fail-closed — `OpenAIConfig.default_model` has no compiled-in vendor value, and an unresolved model raises (`require_model()`) rather than being substituted. Informational only (providers listing).',
    '',
  ),

  // ── Anthropic (TEXT_ANTHROPIC_) ────────────────────────────────────────────
  textProviderEnv(
    'textAnthropic.baseUrl',
    'TEXT Anthropic base URL',
    'Anthropic API base URL for TEXT’s platform-fallback client (`AnthropicConfig.base_url`). Empty ⇒ the SDK default (`https://api.anthropic.com`); a tenant BYO connection may override it per request.',
    '',
  ),
  textProviderEnv(
    'textAnthropic.defaultModel',
    'TEXT Anthropic default model',
    'Empty by design (TASK-579): provider/model SELECTION is fail-closed — `AnthropicConfig.default_model` has no compiled-in vendor value, and an unresolved model raises (`require_model()`) rather than being substituted. Informational only (providers listing).',
    '',
  ),

  // ── Google Vertex AI (TEXT_VERTEX_) ────────────────────────────────────────
  textProviderEnv(
    'textVertex.project',
    'TEXT Vertex project',
    'GCP project id for TEXT’s platform-fallback Vertex client (`VertexConfig.project`). Empty ⇒ no platform fallback (Vertex is then usable only via a tenant BYO service-account connection). A Vertex client is bound to a `(project, location)`; a tenant override supplies its own.',
    '',
  ),
  textProviderEnv(
    'textVertex.location',
    'TEXT Vertex location',
    'GCP location/region for TEXT’s platform-fallback Vertex client (`VertexConfig.location`), e.g. `us-central1`.',
    'us-central1',
  ),
  textProviderEnv(
    'textVertex.defaultModel',
    'TEXT Vertex default model',
    'Empty by design (TASK-579): provider/model SELECTION is fail-closed — `VertexConfig.default_model` has no compiled-in vendor value, and an unresolved model raises (`require_model()`) rather than being substituted. Informational only (providers listing).',
    '',
  ),
];
