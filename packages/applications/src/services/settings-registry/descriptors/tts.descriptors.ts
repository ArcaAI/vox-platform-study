// TTS descriptors.
//
// The BYO provider credentials are the canonical data-class-2 example: per-tenant
// secrets stored as Vault-Transit ciphertext in a DB column. Registered
// here as `db-secret` / `secret` sensitivity so the catalog and any UI treat them
// write-only and masked.

import { SettingDescriptor } from '../registry.types';

// BYO providers that accept a tenant-supplied key (mirrors BYO_PROVIDERS in
// tenant-tts-config/platform-limits). One db-secret descriptor per provider.
const BYO_PROVIDERS = ['azure', 'sarvam'] as const;

export const TTS_SETTINGS: SettingDescriptor[] = [
  ...BYO_PROVIDERS.map<SettingDescriptor>((provider) => ({
    key: `tts.credential.${provider}`,
    tier: 'db-secret',
    dataType: 'secret',
    sensitivity: 'secret',
    maxScope: 'tenant',
    editableBy: 'TenantTtsConfig',
    // Secret ⇒ fail-closed, enforced by `SettingsRegistry.register`. A BYO key
    // that fell back would silently send this tenant's audio through the
    // platform's own provider account.
    failMode: 'closed',
    category: 'Credentials',
    label: `${provider[0].toUpperCase()}${provider.slice(1)} TTS API key (BYO)`,
    description: `Tenant-supplied ${provider} key, encrypted at rest via Vault Transit; write-only, never returned.`,
  })),
  {
    key: 'tts.defaultVoiceEn',
    tier: 'db-config',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'TenantTtsConfig',
    // Voice preference, not provider selection — an unset voice legitimately
    // falls through to the platform default.
    failMode: 'open-to-default',
    category: 'Speech',
    label: 'Default English voice',
    description: 'Default voice used for English text-to-speech.',
  },
];
