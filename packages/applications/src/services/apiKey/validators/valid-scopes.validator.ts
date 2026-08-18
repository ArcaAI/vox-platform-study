import { ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments } from 'class-validator';
import { isValidScope, isReservedScope, API_KEY_SCOPE_REGISTRY } from '../apikey-scopes.registry';

@ValidatorConstraint({ name: 'validScopes', async: false })
export class ValidScopesConstraint implements ValidatorConstraintInterface {
  validate(scopes: string[], _args: ValidationArguments): boolean {
    if (!Array.isArray(scopes)) return false;
    if (scopes.length === 0) return true;
    return scopes.every((scope) => isValidScope(scope));
  }

  defaultMessage(args: ValidationArguments): string {
    const scopes = args.value as string[];
    if (!Array.isArray(scopes)) return 'Scopes must be an array of strings';
    const invalid = scopes.filter((s) => !isValidScope(s));
    return `Invalid scope(s): ${invalid.join(', ')}. Valid scopes: ${Object.keys(API_KEY_SCOPE_REGISTRY).join(', ')}`;
  }
}

/**
 * TASK-757 (policy A2) — refuse to GRANT a reserved scope.
 *
 * Deliberately a SECOND constraint rather than a tightening of
 * `ValidScopesConstraint`, because the two answer different questions and only
 * one of them may be applied to an update:
 *
 * - `ValidScopesConstraint` = "is this a registry member?" — wired to BOTH the
 *   create and the update DTO, and must keep returning `true` for a reserved
 *   scope so a pre-existing key whose stored array contains `admin:*` can still
 *   be renamed without the validation pipe rejecting a field the caller never
 *   sent.
 * - `NoReservedScopesConstraint` = "may this be granted now?" — wired to the
 *   CREATE DTO only, where every scope in the array is by definition new.
 *
 * On UPDATE the equivalent rule is a DELTA rule ("reject only scopes ADDED by
 * this PATCH"), and a class-validator constraint cannot see the stored key. It
 * therefore lives in `ApiKeyService.update()` instead. That split is forced by
 * the mechanism, not a stylistic choice.
 *
 * Unknown strings pass here — membership is the other constraint's job, and
 * failing them twice would produce two error messages for one typo.
 */
@ValidatorConstraint({ name: 'noReservedScopes', async: false })
export class NoReservedScopesConstraint implements ValidatorConstraintInterface {
  validate(scopes: string[], _args: ValidationArguments): boolean {
    if (!Array.isArray(scopes)) return false;
    return !scopes.some((scope) => isReservedScope(scope));
  }

  defaultMessage(args: ValidationArguments): string {
    const scopes = args.value as string[];
    const reserved = Array.isArray(scopes) ? scopes.filter((s) => isReservedScope(s)) : [];
    return (
      `Reserved scope(s) cannot be granted to an API key: ${reserved.join(', ')}. ` +
      `The /api/v1/admin/* plane is JWT-only (policy A2), so these scopes can never authorize a request.`
    );
  }
}
