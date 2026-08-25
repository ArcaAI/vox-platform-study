import { getJson, patchWithEtag, postJson } from '@/shared/api';
import type { Paginated } from '@/shared/api';
import type { ConsentGrant, CreateConsentGrantRequest, ListConsentGrantsParams, RevokeConsentGrantRequest } from './types';

const BASE = 'admin/consent-grants';

/** The tenant consent register — paginated, optional patient/purpose/lifecycle filters. */
export function listConsentGrants(params: ListConsentGrantsParams = {}): Promise<Paginated<ConsentGrant>> {
  return getJson(BASE, { ...params });
}

/**
 * Every grant for one patient. Fetched with a generous page size rather than
 * paginated: a patient has at most one ACTIVE row per purpose (the DB's
 * partial unique index), so the ceiling is the purpose count plus however many
 * revoked rows have accumulated — never a page-worth of live data to walk.
 */
export async function listGrantsForPatient(externalPatientId: string): Promise<ConsentGrant[]> {
  const page = await listConsentGrants({ externalPatientId, page: 0, limit: 50, state: 'ALL' });
  return [...(page.data ?? [])];
}

export function createConsentGrant(body: CreateConsentGrantRequest): Promise<ConsentGrant> {
  return postJson(BASE, body);
}

/**
 * Revoke under RFC 7232 optimistic concurrency. `If-Match` is MANDATORY on
 * this route (`@RequiresIfMatch()`): omitting it is 428, drift is 412. There
 * is no GET-by-id, so the precondition comes from the `version` the list read
 * carried — the same number the gateway renders as the row's ETag.
 */
export async function revokeConsentGrant(id: string, body: RevokeConsentGrantRequest, expectedVersion: number): Promise<ConsentGrant> {
  const result = await patchWithEtag<ConsentGrant>(`${BASE}/${encodeURIComponent(id)}/revoke`, { ...body, expectedVersion }, `"${expectedVersion}"`);
  return result.data;
}
