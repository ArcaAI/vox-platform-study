/**
 * Wire types for the tenant STT-config admin surface.
 * Hand-declared to mirror the gateway DTOs — no server import (BFF boundary).
 * Source: apps/api/src/modules/tenant-stt-config/tenant-stt-config-admin.controller.ts
 */

export type SttProvider = 'azure-speech' | 'sarvam' | 'openai';

/** Resolved effective fallback spec (tenant row over the SYSTEM default). */
export interface EffectiveSttConfig {
  tenantId: string;
  fallbackPipelineId: string | null;
  autoSwitchEnabled: boolean;
  consecutiveFailureThreshold: number;
}

/** Raw editable row — nullable fields inherit; carries the OCC version. */
export interface SttConfigRow {
  tenantId: string;
  fallbackPipelineId?: string | null;
  autoSwitchEnabled: boolean;
  consecutiveFailureThreshold?: number | null;
  configJson?: Record<string, unknown> | null;
  resourceStatus?: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

/** PUT row body — expectedVersion is REQUIRED (0 = create). */
export interface SetSttFallbackRequest {
  /** null clears the pointer; omitted = unchanged. */
  fallbackPipelineId?: string | null;
  autoSwitchEnabled?: boolean;
  consecutiveFailureThreshold?: number;
  expectedVersion: number;
}

/**
 * GET admin/stt-config/fallback-candidates — the enabled, cloud-engine-backed
 * pipelines a tenant may target. Subset of the gateway PipelineResponse the
 * picker needs.
 */
export interface SttPipelineCandidate {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  resourceStatus: string;
  tags: string[];
}

/** Masked credential view — never carries the key. */
export interface SttCredential {
  provider: string;
  region?: string | null;
  endpoint?: string | null;
  model?: string | null;
  enabled: boolean;
  hasKey: boolean;
  keyVersion?: number | null;
  /** OCC version — echo as If-Match `"<version>"` on the next write (0 = create). */
  version: number;
  updatedAt?: string;
}

/** Write-only credential set/rotate body. expectedVersion is the OCC token. */
export interface SetSttCredentialRequest {
  apiKey: string;
  region?: string;
  endpoint?: string;
  model?: string;
  enabled?: boolean;
  expectedVersion: number;
}

/** Ephemeral "Test connection" probe body — never persisted, no OCC. */
export interface TestSttCredentialRequest {
  apiKey: string;
  region?: string;
  endpoint?: string;
}

/** Result of an ephemeral BYO-provider probe. */
export interface TestSttCredentialResult {
  ok: boolean;
  message: string;
}
