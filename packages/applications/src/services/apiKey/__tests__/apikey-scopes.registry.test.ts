import { describe, it, expect } from 'vitest';
import {
    API_KEY_SCOPE_REGISTRY,
    isValidScope,
    getAvailableScopes,
    getScopesByCategory,
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
            const scopeNames = scopes.map(s => s.scope);
            expect(scopeNames).toContain('stt:transcription:read');
            expect(scopeNames).toContain('admin:*');
            expect(scopeNames).toContain('*');
        });
    });

    describe('getScopesByCategory', () => {
        it('should group scopes by category', () => {
            const grouped = getScopesByCategory();
            expect(grouped).toHaveProperty('STT');
            expect(grouped).toHaveProperty('Consultation');
            expect(grouped).toHaveProperty('Admin');
            expect(grouped).toHaveProperty('Wildcard');
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
            const sttScopes = grouped['STT'].map(s => s.scope);
            expect(sttScopes).toContain('stt:transcription:read');
            expect(sttScopes).toContain('stt:transcription:write');
        });
    });
});
