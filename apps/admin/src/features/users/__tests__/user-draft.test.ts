import { describe, expect, it } from 'vitest';
import {
    isCreateUserValid,
    suggestUsername,
    toCreateUserInput,
    toUpdateUserInput,
    validateCreateUserDraft,
    type CreateUserDraft,
} from '../user-draft';

const baseDraft: CreateUserDraft = {
    fullName: '',
    username: 'maya.chen',
    email: 'maya.chen@acme.health',
    password: 'TempPass123',
    isServiceAccount: false,
    roleId: undefined,
    departmentIds: [],
};

describe('suggestUsername (Create User UX — derive a username from the full name)', () => {
    it('strips honorifics and dot-joins first/last, lowercased', () => {
        expect(suggestUsername('Dr. Maya Chen')).toBe('maya.chen');
        expect(suggestUsername('Anaya Rao')).toBe('anaya.rao');
    });

    it('removes diacritics and punctuation', () => {
        expect(suggestUsername('José García')).toBe('jose.garcia');
        expect(suggestUsername("Liam O'Brien")).toBe('liam.obrien');
    });

    it('returns an empty string for junk input (caller keeps the manual username)', () => {
        expect(suggestUsername('   ')).toBe('');
        expect(suggestUsername('###')).toBe('');
    });
});

describe('validateCreateUserDraft (inline validation, REAL useUsers.create)', () => {
    it('accepts a well-formed human draft', () => {
        expect(validateCreateUserDraft(baseDraft)).toEqual({});
        expect(isCreateUserValid(baseDraft)).toBe(true);
    });

    it('requires a username and enforces the lowercase handle pattern', () => {
        expect(validateCreateUserDraft({ ...baseDraft, username: '' }).username).toBeDefined();
        expect(validateCreateUserDraft({ ...baseDraft, username: 'Has Space' }).username).toBeDefined();
        expect(validateCreateUserDraft({ ...baseDraft, username: 'UPPER' }).username).toBeDefined();
    });

    it('requires a valid email for a human user', () => {
        expect(validateCreateUserDraft({ ...baseDraft, email: '' }).email).toBeDefined();
        expect(validateCreateUserDraft({ ...baseDraft, email: 'not-an-email' }).email).toBeDefined();
    });

    it('treats email as optional for a service account', () => {
        expect(validateCreateUserDraft({ ...baseDraft, isServiceAccount: true, email: '' }).email).toBeUndefined();
    });

    it('only flags the temp password when present and too short (invite flow allows empty)', () => {
        expect(validateCreateUserDraft({ ...baseDraft, password: '' }).password).toBeUndefined();
        expect(validateCreateUserDraft({ ...baseDraft, password: 'short' }).password).toBeDefined();
    });
});

describe('toCreateUserInput (draft → SDK CreateUserInput)', () => {
    it('forwards trimmed username/email/password and the service-account flag', () => {
        expect(toCreateUserInput({ ...baseDraft, username: '  maya.chen ', email: ' maya@x.io ', password: ' TempPass123 ' })).toEqual({
            username: 'maya.chen',
            email: 'maya@x.io',
            password: 'TempPass123',
            isServiceAccount: false,
        });
    });

    it('omits empty email/password (invite flow / service account without mailbox)', () => {
        expect(toCreateUserInput({ ...baseDraft, email: '', password: '', isServiceAccount: true })).toEqual({
            username: 'maya.chen',
            isServiceAccount: true,
        });
    });
});

describe('toUpdateUserInput (Profile edit → SDK UpdateUserInput, only SDK-supported fields)', () => {
    it('maps trimmed username/email/status + service-account, omitting empties', () => {
        expect(
            toUpdateUserInput({ username: ' maya.chen ', email: ' maya@x.io ', resourceStatus: 'ENABLED', isServiceAccount: false }),
        ).toEqual({ username: 'maya.chen', email: 'maya@x.io', resourceStatus: 'ENABLED', isServiceAccount: false });
    });

    it('omits an empty email/status rather than sending blank values', () => {
        expect(toUpdateUserInput({ username: 'svc.bot', email: '', resourceStatus: '', isServiceAccount: true })).toEqual({
            username: 'svc.bot',
            isServiceAccount: true,
        });
    });
});
