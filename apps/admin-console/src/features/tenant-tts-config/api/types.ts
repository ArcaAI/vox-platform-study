/**
 * Wire types for the tenant TTS-config admin surface (TASK-504 Phase 4).
 * Hand-declared to mirror the gateway DTOs — no server import (BFF boundary).
 * Source: apps/api/src/modules/tenant-tts-config/tenant-tts-config-admin.controller.ts
 */

export type TtsProvider = 'azure' | 'sarvam';
export type TtsFormat = 'pcm' | 'wav' | 'mp3';

/** Resolved/clamped effective config — every field concrete. */
export interface EffectiveTtsConfig {
  tenantId: string;
  routingEn: string[];
  routingMl: string[];
  allowedProviders: string[];
  defaultVoiceEn: string | null;
  defaultVoiceMl: string | null;
  defaultFormat: string;
  defaultSpeed: number;
  sampleRate: number;
  maxInputChars: number;
  sarvamPublicApiAllowed: boolean;
}

/** Raw row — nullable fields = inherit; carries the OCC version. */
export interface TtsConfigRow {
  tenantId: string;
  defaultVoiceEn?: string | null;
  defaultVoiceMl?: string | null;
  routingEn: string[];
  routingMl: string[];
  allowedProviders: string[];
  defaultFormat?: string | null;
  defaultSpeed?: number | null;
  sampleRate?: number | null;
  maxInputChars?: number | null;
  sarvamPublicApiAllowed: boolean;
  resourceStatus?: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

/** PUT row body — expectedVersion is REQUIRED (0 = create). */
export interface UpdateTtsConfigRequest {
  defaultVoiceEn?: string | null;
  defaultVoiceMl?: string | null;
  routingEn?: string[];
  routingMl?: string[];
  allowedProviders?: string[];
  defaultFormat?: TtsFormat | null;
  defaultSpeed?: number | null;
  sampleRate?: number | null;
  maxInputChars?: number | null;
  sarvamPublicApiAllowed?: boolean;
  expectedVersion: number;
}

/** Masked credential view — never carries the key. */
export interface TtsCredential {
  provider: string;
  endpoint?: string | null;
  enabled: boolean;
  hasKey: boolean;
  keyVersion?: number | null;
  updatedAt?: string;
}

/** Write-only credential set/rotate body. */
export interface SetTtsCredentialRequest {
  apiKey: string;
  endpoint?: string;
  enabled?: boolean;
}
