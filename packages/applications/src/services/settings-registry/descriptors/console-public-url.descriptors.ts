// TASK-1056 — the public origin of the admin console, used to absolutize links HOPE hands to a human
// outside the console (password-reset today).
//
// TIER: `global-kv`, not `env`. A public domain is configuration a tenant may own (a white-label
// host), not a bootstrap value — it used to be `PASSWORD_RESET_BASE_URL` with a hardcoded
// `http://localhost:5176` fallback, and an environment that forgot to set it minted localhost links.
//
// SCOPE: `maxScope: 'tenant'` — tenant row → SYSTEM row. The SYSTEM row is set per environment in the
// console; nothing seeds it, because a seed ships the same domain to every cluster.
//
// FAIL MODE: `closed`, no default. An unset origin is never guessed — and never taken from the
// request `Host`, which a caller controls (reset-link poisoning). The consumer degrades to a RELATIVE
// link and sends no email; the reset itself still succeeds.

import { SettingDescriptor } from '../registry.types';

export const CONSOLE_PUBLIC_BASE_URL_KEY = 'console.publicBaseUrl';

/** Returns a refusal message, or nothing when `value` is a bare http(s) origin (optional trailing slash). */
export function validateConsolePublicBaseUrl(value: unknown): string | void {
  const refusal = 'Must be an absolute http(s) origin with no path, query or fragment, e.g. https://admin.example.com';
  if (typeof value !== 'string' || !value.trim()) return refusal;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return refusal;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return refusal;
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return refusal;
}

export const CONSOLE_PUBLIC_URL_SETTINGS: SettingDescriptor[] = [
  {
    key: CONSOLE_PUBLIC_BASE_URL_KEY,
    tier: 'global-kv',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    failMode: 'closed',
    category: 'Console',
    label: 'Admin console public URL',
    description:
      'The public origin of the admin console (e.g. https://admin.example.com), used to build links sent outside the console, ' +
      'such as password-reset links. A tenant value overrides the platform value. When neither is set, reset links are returned ' +
      'relative to the console and no reset email is sent.',
    validate: validateConsolePublicBaseUrl,
  },
];
