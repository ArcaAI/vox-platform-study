import type { CreateUserInput, UpdateUserInput } from '@arcaai/vox';

/**
 * Create-User dialog draft (frame `120:10354`). `fullName` is a UX helper used to
 * suggest a `username`; `roleId`/`departmentIds` are applied AFTER `useUsers.create`
 * via `assignRoleToUser` / `assignDepartments` (both REAL). The invite/no-password
 * path is a TARGET (the backend invite-email flow ships later).
 */
export interface CreateUserDraft {
  fullName: string;
  username: string;
  email: string;
  password: string;
  isServiceAccount: boolean;
  roleId?: string;
  departmentIds: string[];
}

export const EMPTY_CREATE_USER_DRAFT: CreateUserDraft = {
  fullName: '',
  username: '',
  email: '',
  password: '',
  isServiceAccount: false,
  roleId: undefined,
  departmentIds: [],
};

/** Profile-edit draft — only the fields `UpdateUserInput` actually supports (name/phone = TARGET). */
export interface ProfileDraft {
  username: string;
  email: string;
  resourceStatus: string;
  isServiceAccount: boolean;
}

export interface CreateUserErrors {
  username?: string;
  email?: string;
  password?: string;
}

const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'sir', 'madam', 'mx']);
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

/**
 * Suggest a handle from a display name: strip diacritics + honorifics, keep
 * alphanumeric tokens, dot-join them lowercased. Returns `''` for junk input so
 * the caller keeps whatever the operator typed manually.
 */
export function suggestUsername(fullName: string): string {
  const normalized = fullName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Elide intra-word apostrophes (O'Brien → obrien) before tokenizing.
    .replace(/['’]/g, '');
  const tokens = normalized
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t, i, arr) => !(i === 0 && arr.length > 1 && HONORIFICS.has(t)));
  return tokens.join('.');
}

export function validateCreateUserDraft(draft: CreateUserDraft): CreateUserErrors {
  const errors: CreateUserErrors = {};

  const username = draft.username.trim();
  if (!username) errors.username = 'Username is required';
  else if (!USERNAME_RE.test(username)) errors.username = 'Use lowercase letters, numbers, dot, underscore or hyphen';

  const email = draft.email.trim();
  if (!email) {
    // A human account needs a mailbox; service accounts can be mail-less.
    if (!draft.isServiceAccount) errors.email = 'Email is required';
  } else if (!EMAIL_RE.test(email)) {
    errors.email = 'Enter a valid email address';
  }

  if (draft.password && draft.password.length < MIN_PASSWORD) {
    errors.password = `Use at least ${MIN_PASSWORD} characters`;
  }

  return errors;
}

export function isCreateUserValid(draft: CreateUserDraft): boolean {
  return Object.keys(validateCreateUserDraft(draft)).length === 0;
}

export function toCreateUserInput(draft: CreateUserDraft): CreateUserInput {
  const input: CreateUserInput = { username: draft.username.trim(), isServiceAccount: draft.isServiceAccount };
  const email = draft.email.trim();
  if (email) input.email = email;
  const password = draft.password.trim();
  if (password) input.password = password;
  return input;
}

export function toUpdateUserInput(draft: ProfileDraft): UpdateUserInput {
  const input: UpdateUserInput = { isServiceAccount: draft.isServiceAccount };
  const username = draft.username.trim();
  if (username) input.username = username;
  const email = draft.email.trim();
  if (email) input.email = email;
  const status = draft.resourceStatus.trim();
  if (status) input.resourceStatus = status;
  return input;
}
