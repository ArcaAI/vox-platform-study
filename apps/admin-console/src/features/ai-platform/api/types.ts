/**
 * Wire types for the provider-configuration plane (`admin/routing-policies`).
 * Hand-declared to mirror the gateway DTOs — no server import (BFF boundary).
 *
 * Source of truth:
 *   apps/api/src/modules/ai-routing-policy/ai-routing-policy-admin.controller.ts
 *   packages/applications/src/services/ai-routing-policy/dto/*
 *   packages/applications/src/services/ai-routing-policy/provider-configuration.ts
 *
 * re-grained this table so ONE ROW IS ONE PROVIDER CONFIGURATION: the
 * ordered chain is the set of rows for a (tenant, taskKey), and exactly one of
 * them carries `isDefault` — enforced by a partial unique index, so it is a
 * database fact rather than a convention this client has to defend.
 */

/** One persisted provider configuration (`AiRoutingPolicy` row). */
export interface AiRoutingPolicy {
  id: string;
  tenantId: string;
  taskKey: string;
  /** taxonomy, derived from `taskKey`. NULL = written by an un-migrated writer. */
  taskKind: string | null;
  displayName: string | null;
  /** FK → AiProviderConnection.id — where work is sent and how it authenticates. */
  providerConnectionId: string | null;
  /** FK → AiModel.id — the catalogue model this configuration selects. */
  modelId: string | null;
  /** Provider-side model id on the wire, when it differs from the catalogue slug. */
  modelRef: string | null;
  /** The ELECTED default for this (tenantId, taskKey). At most one row per selection. */
  isDefault: boolean;
  enabled: boolean;
  residency: string | null;
  baaCovered: boolean | null;
  policyVersion: number;
  status: string;
  strategy: string;
  explicitProviderMode: string;
  priority: number;
  killSwitch: boolean;
  match: unknown;
  candidates: unknown;
  fallback: unknown;
  health: unknown;
  affinity: unknown;
  maxConcurrentStreams: number | null;
  requestsPerMinute: number | null;
  tokensPerMinute: number | null;
  supersedesVersion: number | null;
  activatedAt: string | null;
  resourceStatus?: string;
  /** OCC version — the If-Match / ETag token. */
  version: number;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string | null;
  updatedBy?: string | null;
}

/** A candidate the resolver admitted, in the order it would be tried. */
export interface ResolvedRoutingCandidate {
  step: number;
  rank: number;
  weight: number;
  connectionRef: string;
  model: string;
  residency: string;
  baaCovered: boolean;
  funding: string;
  maxTtftMs: number | null;
}

/** Why nothing may serve. `code` is machine-readable, per */
export interface RoutingRejection {
  code: string;
  message: string;
  /** Whether retrying may succeed later (a health ejection) or never (a gate). */
  retryable: boolean | null;
}

/** A candidate the resolver REFUSED, with the gate that refused it. */
export interface RejectedRoutingCandidate {
  rank: number;
  connectionRef: string;
  model: string;
  reason: string;
}

/**
 * GET admin/routing-policies/effective — what actually serves a (tenant, task)
 * right now. The chain is ALREADY GATED: a hop that would cross residency
 * class, BAA coverage or funding tier appears under `rejected`, never under
 * `fallbackChain`, so the console renders what the runtime would really do
 * rather than what the rows nominally say.
 */
export interface EffectiveRoutingPolicy {
  tenantId: string;
  taskKey: string;
  /** 'tenant' when the request tenant's own ACTIVE policy won, 'system' when it inherited the platform default, null when neither exists. */
  source: string | null;
  policyId: string | null;
  policyVersion: number | null;
  strategy: string | null;
  explicitProviderMode: string | null;
  /** The primary candidate , or null when nothing may serve. */
  primary: ResolvedRoutingCandidate | null;
  fallbackChain: ResolvedRoutingCandidate[];
  rejectedCandidates: RejectedRoutingCandidate[];
  /** Set when the request cannot be served at all — selection is fail-closed, never substituted. */
  rejection: RoutingRejection | null;
  /** Which hard gates the winning policy explicitly relaxed. Empty in the default posture. */
  relaxedGates: string[];
  health: unknown;
  maxConcurrentStreams: number | null;
  requestsPerMinute: number | null;
  tokensPerMinute: number | null;
}

/** POST admin/routing-policies body. `isDefault` is deliberately not accepted — election is its own audited transition. */
export interface CreateAiRoutingPolicyRequest {
  taskKey: string;
  displayName?: string;
  providerConnectionId?: string;
  modelId?: string;
  modelRef?: string;
  enabled?: boolean;
  residency?: string;
  baaCovered?: boolean;
  priority?: number;
  policyVersion?: number;
  strategy?: string;
  explicitProviderMode?: string;
  killSwitch?: boolean;
}

/** PATCH admin/routing-policies/:id body (OCC). */
export interface UpdateAiRoutingPolicyRequest {
  displayName?: string;
  providerConnectionId?: string;
  modelId?: string;
  modelRef?: string;
  enabled?: boolean;
  residency?: string;
  baaCovered?: boolean;
  priority?: number;
  killSwitch?: boolean;
  expectedVersion?: number;
}

/**
 * One configuration inside an export artifact.
 *
 * There is NO credential field and no `last4` — deliberately.
 * `provider-configuration.ts` records why: the credential is Vault-Transit
 * ciphertext, so producing a last-4 would mean decrypting a live key on a path
 * whose whole purpose is to not handle key material, and four known characters
 * of a structured vendor key are a partial disclosure rather than a mask. What
 * an operator needs is WHICH secret to re-supply, which is what `credentialRef`
 * says. Do not add a hint field to this interface.
 */
export interface ExportedProviderConfiguration {
  taskKey: string;
  taskKind: string | null;
  displayName: string | null;
  connection: { service: string; provider: string } | null;
  modelSlug: string | null;
  modelRef: string | null;
  isDefault: boolean;
  enabled: boolean;
  residency: string | null;
  baaCovered: boolean | null;
  priority: number;
  /** A LOCATOR (`vault-transit:<service>:<provider>:v<n>`), never the credential. */
  credentialRef: string | null;
  hasCredential: boolean;
}

/** GET admin/routing-policies/export — a secret-free, portable artifact. */
export interface ProviderConfigurationExport {
  formatVersion: 1;
  exportedAt: string;
  sourceTenantId: string;
  /** Stated in the artifact so nobody has to infer it from the absence of a field. */
  secretsIncluded: false;
  notice: string;
  configurations: ExportedProviderConfiguration[];
}

/** POST admin/routing-policies/import result. */
export interface ProviderConfigurationImportResult {
  imported: number;
  skipped: number;
  /** Credential locators the operator must now supply out of band. */
  requiresCredential: string[];
}
