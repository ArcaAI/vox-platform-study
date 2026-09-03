import type { ListParams } from '@/shared/api';

/**
 * Consent register types — mirrors `ConsentGrantResponse` /
 * `ListConsentGrantsQuery` on the gateway (`admin/consent-grants`).
 */

export const CONSENT_PURPOSES = ['AI_DOCUMENTATION', 'HISTORY_RETRIEVAL', 'EXTERNAL_TOOL_LOOKUP', 'STYLE_LEARNING', 'QUALITY_REVIEW'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const CONSENT_GRANT_METHODS = ['VERBAL_ATTESTED', 'WRITTEN', 'PORTAL', 'IMPORTED'] as const;
export type ConsentGrantMethod = (typeof CONSENT_GRANT_METHODS)[number];

export type ConsentGrantState = 'ACTIVE' | 'REVOKED' | 'ALL';

/**
 * Human labels. Deliberately spell out what each purpose ACTUALLY authorizes
 * rather than echoing the enum member — a consent screen where the operator
 * cannot tell what they are granting is worse than no screen.
 */
export const PURPOSE_META: Record<ConsentPurpose, { label: string; description: string }> = {
  AI_DOCUMENTATION: {
    label: 'AI documentation',
    description: 'Record the consultation and draft the clinical note from it. Required to start recording.',
  },
  HISTORY_RETRIEVAL: {
    label: 'History retrieval',
    description: "Read this patient's earlier consultations and chain them for context.",
  },
  EXTERNAL_TOOL_LOOKUP: {
    label: 'External tool lookup',
    description: 'Let the agentic loop call external clinical tools with this patient’s context.',
  },
  STYLE_LEARNING: {
    label: 'Style learning',
    description: "Use this patient's notes to learn the clinician's writing style.",
  },
  QUALITY_REVIEW: {
    label: 'Quality review',
    description: 'Use this consultation in quality and safety review sampling.',
  },
};

export const GRANT_METHOD_META: Record<ConsentGrantMethod, { label: string; description: string }> = {
  VERBAL_ATTESTED: { label: 'Verbal, attested', description: 'The patient consented verbally and you are attesting to it.' },
  WRITTEN: { label: 'Written', description: 'A signed paper or digital form exists.' },
  PORTAL: { label: 'Patient portal', description: 'The patient consented themselves through a portal.' },
  IMPORTED: { label: 'Imported', description: 'Carried over from a prior system of record.' },
};

export interface ConsentGrant {
  id: string;
  externalPatientId: string;
  purpose: ConsentPurpose;
  scope?: Record<string, unknown>;
  grantedAt: string;
  grantedBy: string;
  grantMethod: ConsentGrantMethod;
  evidenceRef?: string;
  expiresAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  revocationReason?: string;
  resourceStatus?: 'ENABLED' | 'DISABLED';
  createdAt: string;
  updatedAt: string;
  version: number;
}

/**
 * Grid-driven list params. Extends the console's standard `ListParams`
 * (search/sort/filters/page/limit, serialized by `toListParams`) with the
 * three filters this endpoint exposes as first-class query params.
 */
export interface ListConsentGrantsParams extends ListParams {
  externalPatientId?: string;
  purpose?: ConsentPurpose;
  state?: ConsentGrantState;
}

export interface CreateConsentGrantRequest {
  externalPatientId: string;
  purpose: ConsentPurpose;
  grantMethod: ConsentGrantMethod;
  scope?: Record<string, unknown>;
  grantedAt?: string;
  evidenceRef?: string;
  expiresAt?: string;
}

export interface RevokeConsentGrantRequest {
  reason?: string;
}

/**
 * The lifecycle the UI shows. Derived CLIENT-side from the row so a list
 * fetched with `state=ALL` can still label each row correctly, using the same
 * rule the gateway's `ACTIVE` predicate and `ConsentGrantEntity.isActive`
 * apply: revoked wins, then expiry, else active.
 */
export type ConsentGrantLifecycle = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export function grantLifecycle(grant: ConsentGrant, now: Date = new Date()): ConsentGrantLifecycle {
  if (grant.revokedAt && new Date(grant.revokedAt).getTime() <= now.getTime()) return 'REVOKED';
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}

/**
 * Is this gateway error the ABAC choke point's consent denial?
 *
 * Read off the BODY's `code`, not `GatewayError.code`. The unified error
 * envelope carries `{ code: 'DOMAIN.CONSENT_DENIED', metadata: {...} }`, while
 * `GatewayError.code` is populated from the NestJS `error` field — which this
 * envelope does not set, so it is `undefined` here. Matching on status alone
 * would be wrong too: 403 is also the privilege boundary for super-admin-only
 * routes, which no amount of consent will unblock.
 */
export function isConsentDenied(error: { status: number; details?: unknown }): boolean {
  if (error.status !== 403) return false;
  const body = error.details as { code?: unknown } | undefined;
  return body?.code === 'DOMAIN.CONSENT_DENIED';
}

/** Purpose named by a consent denial, when the envelope carried one. */
export function consentDenialPurpose(error: { details?: unknown }): ConsentPurpose | null {
  const body = error.details as { metadata?: { purpose?: unknown } } | undefined;
  const purpose = body?.metadata?.purpose;
  return typeof purpose === 'string' && (CONSENT_PURPOSES as readonly string[]).includes(purpose) ? (purpose as ConsentPurpose) : null;
}
