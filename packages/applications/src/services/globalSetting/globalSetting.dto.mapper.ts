import { AutoClassMapper, GlobalSettingEntity } from '@arcaai/domains';
import { GlobalSettingResponse, PaginatedGlobalSettingResponse } from './dto';
import { FetchResponse } from '../../common';

/**
 * TASK-396 — secret-setting convention.
 *
 * A row is treated as a secret when it either (a) carries a Vault-encrypted
 * `encryptedValue`, or (b) its namespace/key matches the secret naming
 * convention below. This is what lets the admin console mask the value and
 * enable the audited reveal flow even in the env-mode test stack (where Vault
 * Transit — and therefore `encryptedValue` — is unavailable). The convention
 * matches NONE of the seeded keys, so existing rows are unaffected.
 */
const SECRET_NAMESPACE = 'secrets';
const SECRET_KEY_PATTERN = /(secret|password|token|credential|api[_-]?key|private[_-]?key)/i;

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
