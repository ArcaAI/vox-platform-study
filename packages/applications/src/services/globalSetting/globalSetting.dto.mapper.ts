import { AutoClassMapper, GlobalSettingEntity } from '@arcaai/domains';
import { GlobalSettingResponse, PaginatedGlobalSettingResponse } from './dto';
import { FetchResponse } from '../../common';

/**
 * Secret-setting convention.
 *
 * A row is treated as a secret when it either (a) carries a Vault-encrypted
 * `encryptedValue`, or (b) its namespace/key matches the secret naming
 * convention below. This is what lets the admin console mask the value and
 * enable the audited reveal flow even in the env-mode test stack (where Vault
 * Transit — and therefore `encryptedValue` — is unavailable). The convention
 * matches NONE of the seeded keys, so existing rows are unaffected.
 */
const SECRET_NAMESPACE = 'secrets';

/**
 * The key-naming markers behind the secret convention, expanded to
 * literal substrings (the former `api[_-]?key` / `private[_-]?key` optional
 * groups become three literals each) so the SAME list drives BOTH the runtime
 * regex used by {@link GlobalSettingDtoMapper.isSecretEntity} and the Prisma
 * `contains` clauses of {@link buildSecretSettingFilter} — the mask and the
 * server-side "Secrets only" facet can never diverge.
 */
const SECRET_KEY_MARKERS = ['secret', 'password', 'token', 'credential', 'api_key', 'api-key', 'apikey', 'private_key', 'private-key', 'privatekey'] as const;
const SECRET_KEY_PATTERN = new RegExp(SECRET_KEY_MARKERS.join('|'), 'i');

/**
 * The derived secret predicate as a Prisma `where` fragment: a row
 * is a secret when it carries an encrypted value OR sits in the `secrets`
 * namespace OR its key matches the naming convention — the exact tri-condition
 * of {@link GlobalSettingDtoMapper.isSecretEntity}, reproduced once here for
 * the list path's `secretsOnly` facet (there is no `isSecret` column).
 */
export function buildSecretSettingFilter(): Record<string, unknown> {
  return {
    OR: [
      { encryptedValue: { not: null } },
      { namespace: { equals: SECRET_NAMESPACE, mode: 'insensitive' } },
      ...SECRET_KEY_MARKERS.map((marker) => ({ key: { contains: marker, mode: 'insensitive' } })),
    ],
  };
}

/** Value returned in place of a secret's plaintext on any non-reveal read. */
const MASKED_VALUE = '';

export class GlobalSettingDtoMapper {
  /**
   * True when the row holds a secret (encrypted OR convention-named). Central so
   * the response mapper and any caller share one definition.
   */
  static isSecretEntity(entity: GlobalSettingEntity): boolean {
    if (entity.encryptedValue) return true;
    const namespace = (entity.namespace ?? '').toLowerCase();
    if (namespace === SECRET_NAMESPACE) return true;
    return SECRET_KEY_PATTERN.test(entity.key ?? '');
  }

  static ToResponse(entity: GlobalSettingEntity): GlobalSettingResponse {
    const response = AutoClassMapper(entity, GlobalSettingResponse);
    const secret = GlobalSettingDtoMapper.isSecretEntity(entity);
    response.isSecret = secret;
    // Never emit a secret's plaintext on list/get. The plaintext is only ever
    // returned by the gated, audited reveal endpoint.
    if (secret) {
      response.value = MASKED_VALUE;
    }
    return response;
  }

  static ToPaginatedResponse({ page, limit, count, data }: FetchResponse<GlobalSettingEntity>): PaginatedGlobalSettingResponse {
    return new PaginatedGlobalSettingResponse({
      page,
      limit,
      count,
      data: data.map((globalSetting) => this.ToResponse(globalSetting)),
    });
  }
}
