import { describe, it, expect } from 'vitest';
import { API_KEY_SCOPE_REGISTRY, isValidScope, getAvailableScopes, getScopesByCategory, resolveImpliedPermissions } from '../apikey-scopes.registry';

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

    // TASK-722 Task 1 — the exposure plane's own scope family. Registered
    // here so `@RequiredScopes(...)` (which validates at decoration time
    // against this registry) can reference them once the gateway controller
    // lands. See docs/implementation/TASK-722-Exposure-V1/README.md §4 Task 1.
    it('should contain workflow exposure scopes', () => {
      expect(API_KEY_SCOPE_REGISTRY['workflow:definition:read']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['workflow:run:write']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['workflow:run:read']).toBeDefined();
      expect(API_KEY_SCOPE_REGISTRY['workflow:*']).toBeDefined();
    });

    // TASK-756 T1 — the minting privilege ceiling reads `implies` for EVERY
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

    it('should include all registered scopes', () => {
      const scopes = getAvailableScopes();
      const scopeNames = scopes.map((s) => s.scope);
      expect(scopeNames).toContain('stt:transcription:read');
      expect(scopeNames).toContain('admin:*');
      expect(scopeNames).toContain('*');
    });
  });

  // TASK-756 T2 — wildcards resolve by EXPANSION, not by a literal permission
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

  describe('getScopesByCategory', () => {
    it('should group scopes by category', () => {
      const grouped = getScopesByCategory();
      expect(grouped).toHaveProperty('STT');
      expect(grouped).toHaveProperty('Consultation');
      expect(grouped).toHaveProperty('Admin');
      expect(grouped).toHaveProperty('Wildcard');
      expect(grouped).toHaveProperty('Workflow');
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
