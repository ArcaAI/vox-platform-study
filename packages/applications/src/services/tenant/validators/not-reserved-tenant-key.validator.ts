import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { isReservedTenantKeyShape } from '../tenantKey';

/**
 * Rejects an explicit `key` shaped like a platform-reserved
 * tenant key (`__SYSTEM__`, `__GLOBAL__`, or any `__*__`). Non-string values
 * are left to `@IsString` to reject.
 */
@ValidatorConstraint({ name: 'notReservedTenantKey', async: false })
export class NotReservedTenantKeyConstraint implements ValidatorConstraintInterface {
  validate(key: string): boolean {
    if (typeof key !== 'string') return true;
    return !isReservedTenantKeyShape(key);
  }

  defaultMessage(): string {
    return 'key is reserved for platform-internal tenants';
  }
}
