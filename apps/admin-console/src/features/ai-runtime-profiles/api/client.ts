/**
 * AI runtime-profile client. Paths are gateway-relative; the shared core
 * prepends the `/api/hope` BFF proxy mount so nothing here reaches the gateway
 * directly.
 *
 * Every row lives on the SYSTEM tenant and the route is super-admin-gated, so
 * no working tenant is required and none is sent.
 */

import { deleteJson, getJson, getWithEtag, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type { AiRuntimeProfile, ResolvedRuntimeProfile, UpsertAiRuntimeProfileRequest } from './types';

const BASE = 'admin/ai-runtime-profiles';

/**
 * `PUT row` is `@RequiresIfMatch()` UNCONDITIONALLY — unlike the settings
 * registry lane, which drops the header on a first write. Here a create is
 * expressed as `If-Match: "0"` against the `version: 0` placeholder the read
 * returns when no row exists, so the header is always present and the CAS
 * always has something to compare.
 */
const CREATE_ETAG = '"0"';

/** Query params addressing one row. Omitting `modelSlug` targets the provider default. */
function rowParams(provider: string, modelSlug: string) {
  // `modelSlug: ''` is the provider-default sentinel and MUST survive as an
  // empty string rather than being dropped — `buildQuery` only omits
  // undefined/null, so passing '' explicitly is correct and deliberate.
  return { provider, modelSlug };
}

/** Every SYSTEM profile row. */
export function listRuntimeProfiles(): Promise<AiRuntimeProfile[]> {
  return getJson(BASE);
}

/**
 * One row plus its ETag. A missing row comes back as a `version: 0`
 * placeholder with every knob null — the read never 404s, so the editor opens
 * on an unconfigured (provider, model) pair exactly as it does on a stored one.
 */
export function getRuntimeProfile(provider: string, modelSlug: string): Promise<WithEtag<AiRuntimeProfile>> {
  return getWithEtag(`${BASE}/row`, rowParams(provider, modelSlug));
}

/**
 * The resolved cascade for a (provider, modelSlug): the model-scoped row merged
 * over the provider-level default, per field. This is the inspection read that
 * answers "what would actually be injected" — the reason the editor can show
 * an inherited value next to an overridden one.
 */
export function resolveRuntimeProfile(provider: string, modelSlug: string): Promise<ResolvedRuntimeProfile> {
  return getJson(`${BASE}/resolve`, rowParams(provider, modelSlug));
}

/**
 * Create-or-update under optimistic concurrency. `etag` comes from the prior
 * read; its absence means "no row yet", which is the `"0"` create precondition
 * rather than an omitted header (the route 428s without one).
 */
export function upsertRuntimeProfile(
  provider: string,
  modelSlug: string,
  body: Omit<UpsertAiRuntimeProfileRequest, 'expectedVersion'>,
  etag: string | null,
): Promise<WithEtag<AiRuntimeProfile>> {
  const expectedVersion = etag ? versionFromEtag(etag) : 0;
  return request(`${BASE}/row`, {
    method: 'PUT',
    params: rowParams(provider, modelSlug),
    body: { ...body, expectedVersion },
    etag: etag ?? CREATE_ETAG,
  });
}

/** Soft-delete one row, returning the (provider, model) pair to the cascade. */
export function deleteRuntimeProfile(provider: string, modelSlug: string): Promise<void> {
  return deleteJson(`${BASE}/row`, undefined, rowParams(provider, modelSlug));
}
