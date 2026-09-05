import { describe, it, expect } from 'vitest';
import {
  API_KEY_SCOPE_REGISTRY,
  isValidScope,
  isReservedScope,
  getAvailableScopes,
  getScopesByCategory,
  resolveImpliedPermissions,
} from '../apikey-scopes.registry';

describe('API Key Scope Registry', () => {
  describe('API_KEY_SCOPE_REGISTRY', () => {
    it('should contain STT scopes', () => {
      expect(API_KEY_SCOPE_REGISTRY['stt:transcription:read']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['stt:transcription:write']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['stt:stream:write']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['stt:model:read']).toBeDefined();
    });

    it('should contain consultation scopes', () => {
      expect(API_KEY_SCOPE_REGISTRY['consultation:session:read']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['consultation:session:write']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['consultation:report:read']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['consultation:report:write']).toBeDefined();
    });

    it('should contain user self-service scopes', () => {
      expect(API_KEY_SCOPE_REGISTRY['user:profile:read']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['user:preferences:read']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['user:preferences:write']).toBeDefined();
    });

    it('should contain admin scopes', () => {
      expect(API_KEY_SCOPE_REGISTRY['admin:user:read']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['admin:user:write']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['admin:apikey:read']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['admin:apikey:write']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['admin:tenant:read']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['admin:tenant:write']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['admin:audit:read']).toBeDefined();
    });

    it('should contain wildcard scopes', () => {
      expect(API_KEY_SCOPE_REGISTRY['stt:*']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['consultation:*']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['admin:*']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['*']).toBeDefined();
    });

    // the exposure plane's own scope family. Registered
    // here so `@RequiredScopes(...)` (which validates at decoration time
    // against this registry) can reference them once the gateway controller
    // lands. See Task 1.
    it('should contain workflow exposure scopes', () => {
      expect(API_KEY_SCOPE_REGISTRY['workflow:definition:read']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['workflow:run:write']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['workflow:run:read']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['workflow:*']).toBeDefined();
    });

    // the business-plane (policy A1) scope family. 13 controllers
    // that carried conservative `@ForbidApiKey()` default now
    // declare a real scope, so the vocabulary has to exist before the
    // decorators can reference it (`@RequiredScopes` validates at DECORATION
    // time). Reuse was preferred wherever a scope already fitted:
    // `stt:model:read` gates the ASR pipeline catalog and the previously
    // unused `user:profile:read` gates the three `me`-shaped reads, so neither
    // appears below.
    it('should contain the business-plane scopes policy A1 introduces', () => {
      for (const scope of [
        'ai:inference:write',
        'prompt:template:read',
        'platform:changelog:read',
        'tenant:account:read',
        'tenant:profile:read',
        'tenant:profile:write',
        'tenant:context-schema:read',
        'user:settings:read',
        'user:settings:write',
      ]) {
        expect(API_KEY_SCOPE_REGISTRY[scope], `${scope} must be registered`).toBeDefined();
      }
    });

    it('should contain the ai:* and tenant:* wildcards, for symmetry with stt:*/user:*', () => {
      expect(API_KEY_SCOPE_REGISTRY['ai:*']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['tenant:*']).toBeDefined();
    });

    // The ceiling is only as good as the mapping: a business scope whose
    // `implies` names an ability nobody holds is unmintable, and one that
    // names an ability EVERYBODY holds is a free grant. These are the four
    // that gate a tenant-owned resource, pinned to the CASL pair their own
    // controller declares.
    it('should map the business-plane scopes onto the ability their controller declares', () => {
      const key = (p: { action: string; subject: string }) => `${p.action}:${p.subject}`;
      expect(API_KEY_SCOPE_REGISTRY['prompt:template:read'].implies.map(key)).toEqual(['read:PromptTemplate']);
      expect(API_KEY_SCOPE_REGISTRY['tenant:account:read'].implies.map(key)).toEqual(['read:Tenant']);
      expect(API_KEY_SCOPE_REGISTRY['tenant:profile:write'].implies.map(key)).toEqual(['update:Tenant']);
      expect(API_KEY_SCOPE_REGISTRY['user:settings:write'].implies.map(key)).toEqual(['update:UserSettings']);
    });

    // the minting privilege ceiling reads `implies` for EVERY
    // scope. A scope with no declared implication would sail through the
    // ceiling unchecked, so an undeclared/empty `implies` is a fail-OPEN hole,
    // not an omission. This test is the guard.
    it('should declare a non-empty `implies` for every concrete (non-wildcard) scope', () => {
      const offenders: string[] = [];
      for (const [scope, def] of Object.entries(API_KEY_SCOPE_REGISTRY)) {
        if (def.category === 'Wildcard') continue; // resolved by expansion, never a literal
        if (!Array.isArray(def.implies) || def.implies.length === 0) {
          offenders.push(scope);
          continue;
        }
        for (const p of def.implies) {
          if (!p || typeof p.action !== 'string' || !p.action || typeof p.subject !== 'string' || !p.subject) {
            offenders.push(`${scope} (malformed implied permission)`);
          }
        }
      }
      expect(offenders, `scopes missing a usable \`implies\`: ${offenders.join(', ')}`).toEqual([]);
    });

    it('should resolve to at least one implied permission for EVERY scope, wildcards included', () => {
      const offenders = Object.keys(API_KEY_SCOPE_REGISTRY).filter((scope) => resolveImpliedPermissions(scope).length === 0);
      expect(offenders, `scopes that resolve to no requirement at all: ${offenders.join(', ')}`).toEqual([]);
    });

    it('should have description and category for every scope', () => {
      for (const [scope, def] of Object.entries(API_KEY_SCOPE_REGISTRY)) {
        expect(def.description, `${scope} missing description`).toBeTruthy();
        expect(def.category, `${scope} missing category`).toBeTruthy();
      }
    });
  });

  describe('isValidScope', () => {
    it('should return true for registered scopes', () => {
      expect(isValidScope('stt:transcription:read')).toBe(true);
      expect(isValidScope('admin:user:write')).toBe(true);
      expect(isValidScope('*')).toBe(true);
    });

    it('should return false for unregistered scopes', () => {
      expect(isValidScope('invalid:scope')).toBe(false);
      expect(isValidScope('read')).toBe(false);
      expect(isValidScope('write')).toBe(false);
      expect(isValidScope('')).toBe(false);
      expect(isValidScope('consultations')).toBe(false);
    });

    it('should be case-sensitive', () => {
      expect(isValidScope('STT:TRANSCRIPTION:READ')).toBe(false);
      expect(isValidScope('stt:transcription:read')).toBe(true);
    });
  });

  describe('getAvailableScopes', () => {
    it('should return array of scope objects', () => {
      const scopes = getAvailableScopes();
      expect(Array.isArray(scopes)).toBe(true);
      expect(scopes.length).toBeGreaterThan(0);
    });

    it('should include scope, description, and category in each entry', () => {
      const scopes = getAvailableScopes();
      for (const entry of scopes) {
        expect(entry).toHaveProperty('scope');
        expect(entry).toHaveProperty('description');
        expect(entry).toHaveProperty('category');
      }
    });

    it('should include all GRANTABLE registered scopes', () => {
      const scopes = getAvailableScopes();
      const scopeNames = scopes.map((s) => s.scope);
      expect(scopeNames).toContain('stt:transcription:read');
      expect(scopeNames).toContain('*');
      // `admin:*` is RESERVED and therefore no longer advertised
      // pinned in the reserved-scopes block below.
      expect(scopeNames).not.toContain('admin:*');
    });
  });

  // wildcards resolve by EXPANSION, not by a literal permission
  // of their own. `'*'` and `'<ns>:*'` are registry members that grant every
  // scope beneath them at request time (`ApiKeyService.hasScope`), so the
  // ceiling must charge the minter for everything they unlock.
  describe('resolveImpliedPermissions', () => {
    const key = (p: { action: string; subject: string }) => `${p.action}:${p.subject}`;

    it('returns the declared implications for a concrete scope', () => {
      expect(resolveImpliedPermissions('consultation:session:write').map(key)).toEqual(
        API_KEY_SCOPE_REGISTRY['consultation:session:write'].implies.map(key),
      );
    });

    it("expands 'admin:*' to the union of every admin:-prefixed scope", () => {
      const resolved = new Set(resolveImpliedPermissions('admin:*').map(key));
      const adminScopes = Object.keys(API_KEY_SCOPE_REGISTRY).filter((s) => s.startsWith('admin:') && s !== 'admin:*');
      // 'admin:*' itself sits OUTSIDE the contiguous admin block in the file;
      // enumerate by KEY, never by position, or the most dangerous string is
      // the one that gets missed.
      expect(adminScopes.length).toBeGreaterThan(50);
      for (const scope of adminScopes) {
        for (const p of API_KEY_SCOPE_REGISTRY[scope].implies) {
          expect(resolved.has(key(p)), `admin:* must charge for ${key(p)} (from ${scope})`).toBe(true);
        }
      }
    });

    it("expands '*' to the union of the whole registry, including manage:all", () => {
      const resolved = new Set(resolveImpliedPermissions('*').map(key));
      expect(resolved.has('manage:all')).toBe(true);
      for (const [scope, def] of Object.entries(API_KEY_SCOPE_REGISTRY)) {
        if (scope === '*') continue;
        for (const p of def.implies) {
          expect(resolved.has(key(p)), `* must charge for ${key(p)} (from ${scope})`).toBe(true);
        }
      }
    });

    it('deduplicates repeated implications across an expansion', () => {
      const resolved = resolveImpliedPermissions('*').map(key);
      expect(new Set(resolved).size).toBe(resolved.length);
    });

    it('throws for an unknown scope (fail closed — never resolves to "no requirement")', () => {
      expect(() => resolveImpliedPermissions('not:a:scope')).toThrow(/unknown api key scope/i);
    });
  });

  /**
   * (policy A2) — the `admin:*` and `webhook:*` families are RESERVED,
   * not deleted.
   *
   * `@ForbidApiKey()` on all 65 admin controllers makes every one of these
   * strings inert at request time, but the strings themselves stay in the
   * registry: they are the vocabulary service-account plane reuses,
   * and deleting them would make every already-stored key carrying one fail
   * `isValidScope` and become unreadable. `reserved` marks them un-GRANTABLE
   * while keeping them KNOWN.
 */
  describe('reserved scopes (policy A2)', () => {
    const reservedKeys = () => Object.keys(API_KEY_SCOPE_REGISTRY).filter((s) => API_KEY_SCOPE_REGISTRY[s].reserved === true);

    // 56 -> 57: adds `admin:document-template:manage` (the
    // clinical-document SHAPE catalog). Reserved like every other `admin:*`
    // scope; the vocabulary exists here only so
    // SERVICE_ACCOUNT_SCOPE_REGISTRY can DERIVE its `svc:admin:` twin.
    // 57 -> 56: removes `admin:department-agent:manage` with the
    // routes it gated. `admin:agent-promotion:manage` STAYS — the promotion
    // surface survives, now over workflow definitions, so only its `implies`
    // moved (to `manage:WorkflowDefinition`).
    // 56 -> 55: TASK-862 removes `admin:ai-runtime-profile:manage` with the
    // `AiRuntimeProfile` surface it gated (ceilings moved onto the provider
    // connection, hyper-parameters onto the Agent).
    // 55 -> 56 (TASK-863): adds `admin:agent:manage`.
    // 56 -> 55 (TASK-881): `admin:ai-task-default:manage` retired with the `AiTaskDefault` facade.
    // 55 -> 54 (TASK-882): removes `admin:pipeline-policy:manage` with `PipelinePolicy`.
    // 54 -> 53 (TASK-888): removes `admin:tenant-tts-config:manage` with `TenantTtsConfig`.
    it('marks all 53 admin: scopes reserved — INCLUDING the admin:* wildcard', () => {
      const admin = Object.keys(API_KEY_SCOPE_REGISTRY).filter((s) => s.startsWith('admin:'));
      expect(admin.length).toBe(53);
      // `admin:*` sits OUTSIDE the contiguous admin block in the source file.
      // Enumerating by line range instead of by KEY would leave the single most
      // dangerous string in the family grantable.
      expect(admin).toContain('admin:*');
      for (const scope of admin) {
        expect(API_KEY_SCOPE_REGISTRY[scope].reserved, `${scope} must be reserved`).toBe(true);
      }
    });

    it('marks the whole webhook: family reserved — its only consumer is WebhookController at admin/webhooks', () => {
      const webhook = Object.keys(API_KEY_SCOPE_REGISTRY).filter((s) => s.startsWith('webhook:'));
      expect(webhook.sort()).toEqual(['webhook:*', 'webhook:event:read', 'webhook:event:write']);
      for (const scope of webhook) {
        expect(API_KEY_SCOPE_REGISTRY[scope].reserved, `${scope} must be reserved`).toBe(true);
      }
    });

    it("does NOT reserve the bare '*' — it is the platform SERVICE_ACCOUNT wildcard for /internal/*", () => {
      expect(API_KEY_SCOPE_REGISTRY['*'].reserved).toBeUndefined();
      expect(isReservedScope('*')).toBe(false);
    });

    it('reserves exactly the admin: and webhook: families and nothing else', () => {
      const derived = Object.keys(API_KEY_SCOPE_REGISTRY)
        .filter((s) => s.startsWith('admin:') || s.startsWith('webhook:'))
        .sort();
      expect(reservedKeys().sort()).toEqual(derived);
      // 60 -> 59: removes one admin scope (56 admin + 3 webhook).
      // 59 -> 58: TASK-862 removes `admin:ai-runtime-profile:manage`; 58 -> 59 (TASK-863):
      // `admin:agent:manage` (56 admin + 3 webhook); 59 -> 58 (TASK-881): `admin:ai-task-default:manage`
      // retired with the `AiTaskDefault` facade (55 admin + 3 webhook); 58 -> 57 (TASK-882):
      // `admin:pipeline-policy:manage` retired with `PipelinePolicy` (54 admin + 3 webhook);
      // 57 -> 56 (TASK-888): `admin:tenant-tts-config:manage` retired with `TenantTtsConfig`
      // (53 admin + 3 webhook).
      expect(reservedKeys().length).toBe(56);
    });

    it('isReservedScope answers for members and is false for unknown strings', () => {
      expect(isReservedScope('admin:tenant:write')).toBe(true);
      expect(isReservedScope('admin:*')).toBe(true);
      expect(isReservedScope('webhook:event:write')).toBe(true);
      expect(isReservedScope('consultation:session:read')).toBe(false);
      expect(isReservedScope('not:a:scope')).toBe(false);
    });

    it('keeps reserved scopes VALID — a stored key carrying one must still be readable', () => {
      expect(isValidScope('admin:tenant:write')).toBe(true);
      expect(isValidScope('admin:*')).toBe(true);
      expect(isValidScope('webhook:event:write')).toBe(true);
    });

    it('drops reserved scopes from the advertised catalog (getAvailableScopes)', () => {
      const advertised = getAvailableScopes().map((s) => s.scope);
      expect(advertised).not.toContain('admin:tenant:write');
      expect(advertised).not.toContain('admin:*');
      expect(advertised).not.toContain('webhook:event:write');
      expect(advertised).not.toContain('webhook:*');
      // Non-reserved entries are untouched.
      expect(advertised).toContain('stt:transcription:read');
      expect(advertised).toContain('*');
    });

    it('drops the Admin and Webhook categories entirely from getScopesByCategory', () => {
      const grouped = getScopesByCategory();
      expect(grouped).not.toHaveProperty('Admin');
      expect(grouped).not.toHaveProperty('Webhook');
      const wildcard = grouped['Wildcard'].map((s) => s.scope);
      expect(wildcard).not.toContain('admin:*');
      expect(wildcard).not.toContain('webhook:*');
      expect(wildcard).toContain('*');
      expect(wildcard).toContain('stt:*');
    });

    it('still charges the ceiling for reserved scopes — reservation is a GRANT rule, not a ceiling exemption', () => {
      // `resolveImpliedPermissions` must keep expanding them, or a pre-existing
      // key carrying `admin:*` would look free to widen.
      expect(resolveImpliedPermissions('admin:tenant:write').length).toBeGreaterThan(0);
      expect(resolveImpliedPermissions('admin:*').length).toBeGreaterThan(0);
    });
  });

  describe('getScopesByCategory', () => {
    it('should group scopes by category', () => {
      const grouped = getScopesByCategory();
      expect(grouped).toHaveProperty('STT');
      expect(grouped).toHaveProperty('Consultation');
      expect(grouped).toHaveProperty('Wildcard');
      expect(grouped).toHaveProperty('Workflow');
      // 'Admin' is gone — every entry in it is reserved.
      expect(grouped).not.toHaveProperty('Admin');
    });

    it('should have scope and description in each group entry', () => {
      const grouped = getScopesByCategory();
      for (const [category, scopes] of Object.entries(grouped)) {
        expect(Array.isArray(scopes), `${category} should be an array`).toBe(true);
        for (const entry of scopes) {
          expect(entry).toHaveProperty('scope');
          expect(entry).toHaveProperty('description');
        }
      }
    });

    it('should place STT scopes in STT category', () => {
      const grouped = getScopesByCategory();
      const sttScopes = grouped['STT'].map((s) => s.scope);
      expect(sttScopes).toContain('stt:transcription:read');
      expect(sttScopes).toContain('stt:transcription:write');
    });
  });
});
