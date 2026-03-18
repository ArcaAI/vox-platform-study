import { ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments } from 'class-validator';
import { isValidScope, API_KEY_SCOPE_REGISTRY } from '../apikey-scopes.registry';

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
