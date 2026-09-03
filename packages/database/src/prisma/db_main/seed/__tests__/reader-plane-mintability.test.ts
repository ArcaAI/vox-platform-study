import { describe, it, expect } from 'vitest';
import { DEFAULT_POLICIES } from '../01-policy';
import { DEFAULT_ROLES } from '../03-role';

/**
 * a scope whose implied ability NO seeded policy grants is
 * unmintable by anyone below SUPER_ADMIN.
 *
 * `ApiKeyService.assertScopeCeiling` refuses to mint a key carrying
 * a scope whose implied CASL pair the CALLER does not itself hold. That is the
 * right rule, but it silently contradicts any route that is `@Authorize()` with
 * NO ability — those are open to every authenticated user, yet their scope may
 * imply an ability nobody below a super admin actually has.
 *
 * Two such contradictions existed when this ticket was written:
 *
 * | Scope | Route | Implied ability | Held by |
 * |---|---|---|---|
 * | `platform:changelog:read` | `ChangelogController` `@Authorize()` | `read:ChangelogEntry` | **nobody** — SUPER_ADMIN only, via `manage:all` |
 * | `tenant:context-schema:read` | `MyTenantContextSchemaController` `@Authorize()` | `read:ConsultationContextSchema` | tenant admins only, via `manage:` |
 *
 * So a clinician could USE the What's New dialog and the context-schema
 * discovery endpoint in a browser session, but could not mint an SDK key for
 * either — and the changelog reader plane was unreachable by any tenant-minted
 * key at all.
 *
 * The fix is in `01-policy.ts`: both abilities were added to `user-profile-own`,
 * the "all authenticated users" policy, which is exactly the audience the two
 * routes already have. Neither widens a request-time surface — the only routes
 * declaring these subjects are the ADMIN controllers, and both require
 * `manage:`, which `read` does not imply.
 */

/** Union of `action:subject` pairs a role's policy set grants, following `parentRoleId`. */
function abilitiesFor(roleName: string): Set<string> {
  const byName = new Map(DEFAULT_POLICIES.map((policy) => [policy.name, policy]));
  const role = DEFAULT_ROLES.find((r) => r.name === roleName);
  if (!role) throw new Error(`No seeded role named ${roleName}`);

  const policyNames = [...role.policies];
  let current: (typeof DEFAULT_ROLES)[number] | undefined = role;
  while (current?.parentRoleId) {
    const parent: (typeof DEFAULT_ROLES)[number] | undefined = DEFAULT_ROLES.find((r) => r.id === current!.parentRoleId);
    if (!parent) break;
    policyNames.push(...parent.policies);
    current = parent;
  }

  const abilities = new Set<string>();
  for (const name of policyNames) {
    const policy = byName.get(name);
    if (!policy) throw new Error(`Role references a policy that is not seeded: ${name}`);
    for (const rule of policy.rules) {
      for (const action of Array.isArray(rule.action) ? rule.action : [rule.action]) {
        abilities.add(`${action}:${rule.subject}`);
      }
    }
  }
  return abilities;
}

/** CASL semantics: `manage` subsumes every action, `all` subsumes every subject. */
function can(abilities: Set<string>, action: string, subject: string): boolean {
  return (
    abilities.has('manage:all') || abilities.has(`manage:${subject}`) || abilities.has(`${action}:all`) || abilities.has(`${action}:${subject}`)
  );
}

/**
 * Scope → implied ability, for every business-plane scope whose route is
 * `@Authorize()` with no ability (i.e. open to any authenticated user).
 * Mirrors `apikey-scopes.registry.ts`; `packages/database` cannot import it
 * because the package edge runs the other way.
 */
const OPEN_ROUTE_SCOPES: ReadonlyArray<readonly [scope: string, action: string, subject: string]> = [
  ['platform:changelog:read', 'read', 'ChangelogEntry'],
  ['tenant:context-schema:read', 'read', 'ConsultationContextSchema'],
  ['user:profile:read', 'read', 'UserProfile'],
  ['user:settings:read', 'read', 'UserSettings'],
  ['user:settings:write', 'update', 'UserSettings'],
  ['tenant:profile:read', 'read', 'Tenant'],
  ['tenant:account:read', 'read', 'Tenant'],
  ['prompt:template:read', 'read', 'PromptTemplate'],
  ['stt:model:read', 'read', 'Consultation'],
];

/**
 * The roles whose holders mint SDK keys. DOCTOR carries `api-key-own-manage`,
 * so a clinician mints their own key; TENANT_ADMIN mints on behalf of the
 * tenant. NURSE is excluded deliberately — it holds no `create:ApiKey`.
 */
const KEY_MINTING_ROLES = ['TENANT_ADMIN', 'DOCTOR', 'DEPARTMENT_HEAD'] as const;

describe('reader-plane scopes are mintable by the audience their route already admits', () => {
  for (const roleName of KEY_MINTING_ROLES) {
    const abilities = abilitiesFor(roleName);

    for (const [scope, action, subject] of OPEN_ROUTE_SCOPES) {
      it(`${roleName} can mint "${scope}" (needs ${action}:${subject})`, () => {
        expect(
          can(abilities, action, subject),
          `${roleName} may call this route in a session but assertScopeCeiling would refuse to mint a key for it`,
        ).toBe(true);
      });
    }
  }

  it('SUPER_ADMIN keeps the manage:all grant that clears every ceiling', () => {
    expect(abilitiesFor('SUPER_ADMIN').has('manage:all')).toBe(true);
  });

  it('the two abilities added by this ticket are READ-only — the admin write plane stays closed', () => {
    const doctor = abilitiesFor('DOCTOR');
    // `ChangelogAdminController` and the admin context-schema controller both
    // gate on `manage:`. Granting `read` must not have reached them.
    expect(can(doctor, 'manage', 'ChangelogEntry')).toBe(false);
    expect(can(doctor, 'manage', 'ConsultationContextSchema')).toBe(false);
  });
});
