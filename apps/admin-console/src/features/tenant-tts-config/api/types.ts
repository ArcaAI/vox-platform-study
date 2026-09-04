/**
 * Wire types for the tenant TTS-config admin surface.
 * Hand-declared to mirror the gateway DTOs — no server import (BFF boundary).
 * Source: apps/api/src/modules/tenant-tts-config/tenant-tts-config-admin.controller.ts
 */

export type TtsProvider = 'azure' | 'sarvam';
export type TtsFormat = 'pcm' | 'wav' | 'mp3';

/** Per-voice provider bindings: { [internalVoiceId]: { [provider]: providerVoiceName } }. */
export type TtsVoiceBindings = Record<string, Record<string, string>>;

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
  /** SYSTEM bindings merged under tenant bindings (tenant wins per voice id). */
  voiceBindings?: TtsVoiceBindings;
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
  /** Persisted config extras — carries the tenant `voiceBindings` here. */
  configJson?: Record<string, unknown> | null;
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
  /** Full desired bindings map (persisted under configJson.voiceBindings). */
  voiceBindings?: TtsVoiceBindings;
  expectedVersion: number;
}

/** GET admin/tts-config/catalog — registry-derived platform catalog. */
export interface TtsCatalogVoice {
  id: string;
  locale: string;
  gender?: string;
  name?: string;
}

export interface TtsCatalogProvider {
  provider: string;
  slug: string;
  name: string;
  voices: TtsCatalogVoice[];
}

export interface TtsPlatformCatalog {
  providers: TtsCatalogProvider[];
}
