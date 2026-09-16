/**
 * API-key scope presets — the "Purpose" radio cards on the console's create-key dialog, and the
 * seed's `SDK_DAY_ONE_SCOPES` derivation.
 *
 * Declared once here so the seed (`packages/database`, which depends only on `@arcaai/types`),
 * the scope registry (`packages/applications`), and both SDKs can all read the same three presets
 * rather than hand-maintaining copies that drift.
 */

export type ApiKeyScopePresetKey = 'consultation-app' | 'types-codegen' | 'agents-and-workflows';

export interface ApiKeyScopePreset {
  key: ApiKeyScopePresetKey;
  label: string;
  description: string;
  scopes: readonly string[];
}

export const API_KEY_SCOPE_PRESETS: readonly ApiKeyScopePreset[] = [
  {
    key: 'consultation-app',
    label: 'Consultation app',
    description: 'For a clinic app that opens consultations, streams audio and reads summaries.',
    scopes: [
      'consultation:session:read',
      'consultation:session:write',
      'consultation:report:read',
      'consultation:report:write',
      'stt:transcription:read',
      'stt:transcription:write',
      'stt:stream:write',
      'stt:model:read',
      'tts:speech:write',
      'tts:voice:read',
      'tenant:context-schema:read',
      'tenant:profile:read',
      'user:profile:read',
      'user:preferences:read',
      'user:preferences:write',
      'user:settings:read',
      'user:settings:write',
      'prompt:template:read',
      'dna-writing-style:ingest',
    ],
  },
  {
    key: 'types-codegen',
    label: 'Type generation (build tools)',
    description: "For a build pipeline that generates TypeScript types from this tenant's schema and catalogue. Read-only.",
    scopes: ['tenant:context-schema:read', 'agent:definition:read', 'workflow:definition:read'],
  },
  {
    key: 'agents-and-workflows',
    label: 'Agents & workflows',
    description: "For a server that calls this tenant's published agents and runs its workflows.",
    scopes: [
      'agent:definition:read',
      'agent:invocation:write',
      'workflow:definition:read',
      'workflow:run:read',
      'workflow:run:write',
      'workflows:execute',
    ],
  },
];
