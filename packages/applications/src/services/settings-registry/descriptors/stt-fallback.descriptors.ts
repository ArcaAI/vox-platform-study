// STT fallback + BYOK descriptors (TASK-567, §3.7).
//
// Mirrors the TTS BYO-credential posture: per-tenant STT provider keys are the
// data-class-2 secret example (Vault-Transit ciphertext in a DB column,
// write-only + masked). The fallback pipeline pointer is provider SELECTION, so
// it fails CLOSED like `models.*`; the auto-switch knobs are tuning that degrade
// to their code default. Editable by tenant admins (`editableBy: 'TenantSttConfig'`)
// — STT is already tenant-admin self-service (§3.2), NOT the GLOBAL-ADMIN lock.

import { SettingDescriptor } from '../registry.types';

// BYO providers that accept a tenant-supplied key (mirrors BYO_STT_PROVIDERS in
// tenant-stt-config/platform-limits). One db-secret descriptor per provider.
const BYO_STT_PROVIDERS = ['azure-speech', 'sarvam', 'openai'] as const;

export const STT_FALLBACK_SETTINGS: SettingDescriptor[] = [
  ...BYO_STT_PROVIDERS.map<SettingDescriptor>((provider) => ({
    key: `stt.credential.${provider}`,
    tier: 'db-secret',
    dataType: 'secret',
    sensitivity: 'secret',
    maxScope: 'tenant',
    editableBy: 'TenantSttConfig',
    // Secret ⇒ fail-closed, enforced by `SettingsRegistry.register`. A BYO key
    // that fell back would silently send this tenant's audio through the
    // platform's own provider account.
    failMode: 'closed',
    category: 'Credentials',
    label: `${provider} STT API key (BYO)`,
    description: `Tenant-supplied ${provider} key, encrypted at rest via Vault Transit; write-only, never returned.`,
  })),
  {
    key: 'stt.fallback.pipelineSlug',
    tier: 'db-config',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'TenantSttConfig',
    // Provider/pipeline SELECTION — an unresolvable fallback must never silently
    // become another tenant's or a global pipeline (§3.3 selection-fail-closed).
    failMode: 'closed',
    category: 'Speech',
    label: 'STT fallback pipeline',
    description: 'Tenant-level default fallback pipeline used on classified outage of the primary ASR engine.',
  },
  {
    key: 'stt.fallback.autoSwitchEnabled',
    tier: 'db-config',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'TenantSttConfig',
    // Tuning toggle (default ON) — a missing row degrades to today's auto-switch
    // behaviour. NOT flagged `killSwitch` (that class must default OFF).
    failMode: 'open-to-default',
    default: true,
    category: 'Speech',
    label: 'STT auto-switch to fallback',
    description: 'When on, transcription auto-switches to the fallback pipeline on a classified ASR outage.',
  },
  {
    key: 'stt.fallback.consecutiveFailureThreshold',
    tier: 'db-config',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'TenantSttConfig',
    failMode: 'open-to-default',
    default: 2,
    category: 'Speech',
    label: 'STT auto-switch failure threshold',
    description: 'Consecutive utterance failures on a threshold-class error before auto-switching to the fallback.',
  },
];
