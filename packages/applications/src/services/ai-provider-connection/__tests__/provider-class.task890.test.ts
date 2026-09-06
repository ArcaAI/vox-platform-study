/**
 * TASK-890 L1 — the provider CLASS table (§3.7).
 *
 * `providerClassOf` is the single predicate the tenant catalogue, the publish
 * gate (L8) and the BYO declaration (L10) all read, so it lives beside the
 * connection vocabulary it is derived from rather than inside any one consumer.
 * It replaces `ENGINE_SERVED_PROVIDERS` as a private const in `agent.service.ts`.
 */
import { describe, it, expect } from 'vitest';
import { ModelTaskType } from '@arcaai/domains';
import { ENGINE_SERVED_PROVIDERS, MODEL_TASK_TYPE_SERVICE, PROVIDER_GROUP_HOPE, providerClassOf } from '../constants';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const TENANT = 'tenant-a';

describe('TASK-890 providerClassOf', () => {
  it('classifies any TENANT-owned row as cloud-byo, whatever its provider says', () => {
    expect(providerClassOf('llm', 'azure', { tenantId: TENANT })).toBe('cloud-byo');
    // A tenant row for a self-host engine name is still the tenant's own BYO
    // declaration — the tenant plane has no engines of its own.
    expect(providerClassOf('llm', 'lm-studio', { tenantId: TENANT })).toBe('cloud-byo');
  });

  it('classifies a SYSTEM cloud-vendor row as cloud-platform', () => {
    expect(providerClassOf('llm', 'azure', { tenantId: SYSTEM_TENANT_ID })).toBe('cloud-platform');
    expect(providerClassOf('llm', 'anthropic', { tenantId: SYSTEM_TENANT_ID })).toBe('cloud-platform');
    expect(providerClassOf('stt', 'azure-speech', { tenantId: SYSTEM_TENANT_ID })).toBe('cloud-platform');
  });

  it('classifies a SYSTEM engine row as engine-served, including the `lmstudio` alias', () => {
    for (const provider of ['lm-studio', 'lmstudio', 'ollama', 'vllm', 'llama-cpp']) {
      expect(providerClassOf('llm', provider, { tenantId: SYSTEM_TENANT_ID })).toBe('engine-served');
      expect(ENGINE_SERVED_PROVIDERS.has(provider)).toBe(true);
    }
  });

  it('classifies `built-in` and the platform self-host TTS engines as platform-self-host (§2.7 #13)', () => {
    expect(providerClassOf('stt', 'built-in', { tenantId: SYSTEM_TENANT_ID })).toBe('platform-self-host');
    expect(providerClassOf('tts', 'kokoro', { tenantId: SYSTEM_TENANT_ID })).toBe('platform-self-host');
    expect(providerClassOf('tts', 'indic_parler', { tenantId: SYSTEM_TENANT_ID })).toBe('platform-self-host');
  });

  it('returns null for a SYSTEM row whose provider is unknown or absent (Risk 6 — hidden from tenants)', () => {
    expect(providerClassOf('llm', null, { tenantId: SYSTEM_TENANT_ID })).toBeNull();
    expect(providerClassOf('llm', 'not-a-provider', { tenantId: SYSTEM_TENANT_ID })).toBeNull();
    expect(providerClassOf(null, 'azure', { tenantId: SYSTEM_TENANT_ID })).toBeNull();
  });

  it('maps every serving task type onto the connection service that governs it', () => {
    expect(MODEL_TASK_TYPE_SERVICE[ModelTaskType.TEXT_GENERATION]).toBe('llm');
    expect(MODEL_TASK_TYPE_SERVICE[ModelTaskType.GUARDRAIL]).toBe('llm');
    expect(MODEL_TASK_TYPE_SERVICE[ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION]).toBe('stt');
    expect(MODEL_TASK_TYPE_SERVICE[ModelTaskType.VOICE_ACTIVITY_DETECTION]).toBe('stt');
    expect(MODEL_TASK_TYPE_SERVICE[ModelTaskType.TEXT_TO_SPEECH]).toBe('tts');
    expect(MODEL_TASK_TYPE_SERVICE[ModelTaskType.FEATURE_EXTRACTION]).toBe('embeddings');
    // A task nothing serves over a connection has no service — it is still a
    // catalogue row, classified by its provider alone.
    expect(MODEL_TASK_TYPE_SERVICE[ModelTaskType.TOKEN_CLASSIFICATION]).toBeNull();
  });

  it('names the single Hope provider group id', () => {
    expect(PROVIDER_GROUP_HOPE).toBe('hope');
  });
});
