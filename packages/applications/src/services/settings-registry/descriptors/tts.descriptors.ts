// TTS descriptors.
//
// `tts.credential.{azure,sarvam}` were here — two `db-secret` descriptors
// declared so a catalog or UI would treat the BYO keys as write-only and
// masked. TASK-872 removed them: nothing ever resolved either key. The
// credentials themselves are unaffected, because the registry was never their
// storage or their write path — `TenantTtsConfigService` owns both, through its
// own DTOs and its own Vault-Transit column, and the settings write lane
// refuses a `db-secret` tier outright. A descriptor that describes a value the
// registry can neither read nor write is documentation posing as a control
// surface; the honest place for that documentation is the owning service.

import { SettingDescriptor } from '../registry.types';

export const TTS_SETTINGS: SettingDescriptor[] = [
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
