import { Inject, Injectable } from '@nestjs/common';

import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { SettingsRegistryWriteService } from '../../settings-registry/settings-registry-write.service';
import { PASSWORD_POLICY_SETTING_KEYS, resolvePasswordPolicy } from '../../user/userPassword/password-policy';
import { ISecurityPolicyService } from './ISecurityPolicyService';
import { SecurityPolicyResponse, UpdateSecurityPolicyRequest } from './dto';
import {
  API_KEY_ENCODING,
  MAX_SECRET_BYTES,
  MIN_SECRET_BYTES,
  SECRET_POLICY_SETTING_KEYS,
  STORAGE_ACCESS_KEY_ENCODING,
  resolveGeneratedSecretPolicy,
} from './secret-policy';

/** Request field → the registry key it writes. The whole mapping, in one place. */
const FIELD_TO_KEY: Record<keyof UpdateSecurityPolicyRequest, string> = {
  passwordMinLength: PASSWORD_POLICY_SETTING_KEYS.minLength,
  passwordRequireUppercase: PASSWORD_POLICY_SETTING_KEYS.requireUppercase,
  passwordRequireLowercase: PASSWORD_POLICY_SETTING_KEYS.requireLowercase,
  passwordRequireDigit: PASSWORD_POLICY_SETTING_KEYS.requireDigit,
  passwordRequireSpecial: PASSWORD_POLICY_SETTING_KEYS.requireSpecial,
  passwordMaxAgeDays: PASSWORD_POLICY_SETTING_KEYS.maxAgeDays,
  secretByteLength: SECRET_POLICY_SETTING_KEYS.byteLength,
  secretEncoding: SECRET_POLICY_SETTING_KEYS.encoding,
};

/**
 * The SUPER_ADMIN credential-policy surface.
 *
 * This service deliberately owns NO enforcement of its own. Every write goes
 * through `SettingsRegistryWriteService`, the single descriptor-driven
 * enforcement point — which is what makes these keys super-admin-only (all
 * eight descriptors are `globalOnly`, so a tenant admin gets a 403 there),
 * type-checked against the declared `dataType`, written to the SYSTEM row,
 * broadcast as a sys-event and pushed into the `AppSettings` cache every
 * reader consults. Duplicating any of that here would create a second write
 * path with its own drift.
 *
 * Reads come from the same `AppSettingsService` cache the READERS use, not
 * from the row, so what this returns is exactly what the next password
 * validation and the next credential issuance will apply.
 */
@Injectable()
export class SecurityPolicyService implements ISecurityPolicyService {
  constructor(
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
    private readonly writeService: SettingsRegistryWriteService,
  ) {}

  getPolicy(): SecurityPolicyResponse {
    const password = resolvePasswordPolicy(this.appSettings);
    const secret = resolveGeneratedSecretPolicy(this.appSettings);
    return {
      password,
      secret,
      bounds: {
        minByteLength: MIN_SECRET_BYTES,
        maxByteLength: MAX_SECRET_BYTES,
        pinnedEncodings: { apiKey: API_KEY_ENCODING, storageAccessKey: STORAGE_ACCESS_KEY_ENCODING },
        governedSurfaces: ['serviceAccountClientSecret', 'apiKey', 'webhookSigningSecret', 'storageAccessKey'],
      },
    };
  }

  /**
   * Apply a partial update, one registry write per supplied field.
   *
   * NOT transactional, and deliberately not pretending to be: each key is its
   * own `GlobalSetting` row and the write lane is a per-key compare-and-set. A
   * write that fails (403, type mismatch, concurrent version drift) throws and
   * leaves the earlier keys of the same request applied — so the caller re-reads
   * the returned policy rather than assuming all-or-nothing. Every field of
   * this DTO is independently valid, so a partial application is a coherent
   * policy, never a broken one.
   */
  async updatePolicy(dto: UpdateSecurityPolicyRequest): Promise<SecurityPolicyResponse> {
    for (const [field, key] of Object.entries(FIELD_TO_KEY) as [keyof UpdateSecurityPolicyRequest, string][]) {
      const value = dto[field];
      if (value === undefined) continue;

      // The write lane is compare-and-set: once a row exists it REFUSES a write
      // with no `expectedVersion` (428), so a policy PUT would work exactly once
      // without this. There is no per-key ETag a caller could echo — eight rows
      // have eight versions and this surface exposes one object — so the
      // precondition is taken here, immediately before the write. That is a
      // genuine compare-and-set against the version just observed, not a bypass:
      // a concurrent edit landing in between still fails the write with a 412
      // rather than being silently overwritten. A caller that wants to hold a
      // precondition across its own read uses the per-key registry lane.
      const version = await this.writeService.getBackingRowVersion(key, 'system');
      await this.writeService.write(key, value, {
        scope: 'system',
        // 0 = no row yet; the first write must NOT carry a precondition.
        ...(version > 0 ? { expectedVersion: version } : {}),
      });
    }
    return this.getPolicy();
  }
}
