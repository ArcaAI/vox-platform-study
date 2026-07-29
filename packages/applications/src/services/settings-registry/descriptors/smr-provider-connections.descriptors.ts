// SMR cloud-provider CONNECTION config — tier `env` (TASK-572).
//
// The three cloud LLM providers added in TASK-572 (OpenAI / Anthropic / Google
// Vertex) each carry a small PLATFORM-level connection surface in
// `apps/smr/src/smr/core/config.py` (`OpenAIConfig` / `AnthropicConfig` /
// `VertexConfig`, `SMR_OPENAI_` / `SMR_ANTHROPIC_` / `SMR_VERTEX_` prefixes).
// These are the platform FALLBACK values used when a tenant has no enabled BYO
// connection for the provider — the per-tenant key/endpoint is a different data
// class entirely (`AiProviderConnection`, `db-secret` Vault-Transit ciphertext).
//
// FIELD SEMANTICS FOR THIS TIER (identical to `bootstrap-env.descriptors.ts`):
//   - tier `env`            supplied through the process environment; read by
//                           `apps/smr` (pydantic-settings), never by the gateway.
//   - `editableBy: none`    no admin write path for a deploy-time value; a
//                           governance test binds `tier === 'env'` ⟺ `none`.
//   - `failMode`            DECLARATIVE, not behavioural (env is not a control
//                           plane): `open-to-default` — the reader has a code
//                           fallback, transcribed verbatim into `default`.
//   - `default`            the SMR config class's ACTUAL fallback (config.py).
//
// The CREDENTIALS themselves (`SMR_OPENAI_API_KEY`, `SMR_ANTHROPIC_API_KEY`) are
// a different data class (`vault-kv`, sensitivity `secret`) and live in
// `platform-secrets.descriptors.ts`. Vertex authenticates with a service-account
// JSON (tenant BYO) or Application Default Credentials (platform), so it has no
// `SMR_VERTEX_API_KEY` — only its `(project, location)` routing below.

import { EDITABLE_BY_NONE, SettingDescriptor } from '../registry.types';

/** Shared shape for an SMR cloud-provider connection-config variable. */
function smrProviderEnv(key: string, label: string, description: string, defaultValue?: unknown): SettingDescriptor {
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

export const SMR_PROVIDER_CONNECTION_SETTINGS: SettingDescriptor[] = [
  // ── OpenAI (SMR_OPENAI_) ──────────────────────────────────────────────────
  smrProviderEnv(
    'smrOpenai.baseUrl',
    'SMR OpenAI base URL',
    'OpenAI API base URL for SMR’s platform-fallback OpenAI client (`OpenAIConfig.base_url`). Override for an OpenAI-compatible gateway; a tenant BYO connection may override it per request.',
    'https://api.openai.com/v1',
  ),
  smrProviderEnv(
    'smrOpenai.organization',
    'SMR OpenAI organization',
    'Optional OpenAI organization id sent by SMR’s platform-fallback client (`OpenAIConfig.organization`). Unset ⇒ the account default organization.',
  ),
  smrProviderEnv(
    'smrOpenai.defaultModel',
    'SMR OpenAI default model',
    'Empty by design (TASK-579): provider/model SELECTION is fail-closed — `OpenAIConfig.default_model` has no compiled-in vendor value, and an unresolved model raises (`require_model()`) rather than being substituted. Informational only (providers listing).',
    '',
  ),

  // ── Anthropic (SMR_ANTHROPIC_) ────────────────────────────────────────────
  smrProviderEnv(
    'smrAnthropic.baseUrl',
    'SMR Anthropic base URL',
    'Anthropic API base URL for SMR’s platform-fallback client (`AnthropicConfig.base_url`). Empty ⇒ the SDK default (`https://api.anthropic.com`); a tenant BYO connection may override it per request.',
    '',
  ),
  smrProviderEnv(
    'smrAnthropic.defaultModel',
    'SMR Anthropic default model',
    'Empty by design (TASK-579): provider/model SELECTION is fail-closed — `AnthropicConfig.default_model` has no compiled-in vendor value, and an unresolved model raises (`require_model()`) rather than being substituted. Informational only (providers listing).',
    '',
  ),

  // ── Google Vertex AI (SMR_VERTEX_) ────────────────────────────────────────
  smrProviderEnv(
    'smrVertex.project',
    'SMR Vertex project',
    'GCP project id for SMR’s platform-fallback Vertex client (`VertexConfig.project`). Empty ⇒ no platform fallback (Vertex is then usable only via a tenant BYO service-account connection). A Vertex client is bound to a `(project, location)`; a tenant override supplies its own.',
    '',
  ),
  smrProviderEnv(
    'smrVertex.location',
    'SMR Vertex location',
    'GCP location/region for SMR’s platform-fallback Vertex client (`VertexConfig.location`), e.g. `us-central1`.',
    'us-central1',
  ),
  smrProviderEnv(
    'smrVertex.defaultModel',
    'SMR Vertex default model',
    'Empty by design (TASK-579): provider/model SELECTION is fail-closed — `VertexConfig.default_model` has no compiled-in vendor value, and an unresolved model raises (`require_model()`) rather than being substituted. Informational only (providers listing).',
    '',
  ),
];
