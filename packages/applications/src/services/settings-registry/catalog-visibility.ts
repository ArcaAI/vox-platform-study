// Which registry keys a TENANT administrator may see at all.
//
// ── THE OWNER RULE (TASK-932 R-1, D-5) ───────────────────────────────────────
// "Platform settings MUST NOT be shown to any tenant admin — platform settings
// are for the platform admin only."
//
// Before this, the catalog filtered ONLY `globalOnly`, so a tenant admin
// received every `maxScope: 'system'` descriptor as well: the whole Bootstrap
// floor, the Credentials inventory, Platform Operations, Service Runtime, the
// STT/TTS runtime families — visible, un-writable rows describing the shape of
// the platform's deployment. Two different facts had to be true for a key to be
// hidden and only one of them was checked.
//
// ── THE TEST ────────────────────────────────────────────────────────────────
// A tenant admin sees exactly the keys its OWN tenant can hold an opinion on:
//
//     maxScope ∈ {tenant, department, doctor}   AND   NOT globalOnly
//
// `maxScope: 'system'` says there is no row a tenant could ever own; `globalOnly`
// says the platform decides this one even where a tenant row may exist (the
// per-tenant rollout gates). Either alone makes the key platform-only.
//
// ── WHY 404 AND NOT 403 ─────────────────────────────────────────────────────
// A filtered CATALOG that still answers `GET /registry/:key` is a directory: an
// admin who can enumerate the registry from the source tree learns each key's
// existence, its stored value and its cascade trace one request at a time. So
// the key-addressed routes answer 404 — the same posture the route already took
// for `globalOnly`, extended to the rest of the platform surface. This is
// EXISTENCE HIDING for a configuration surface, not the cross-tenant 404: a
// tenant admin refused a key it CAN see, at a scope it may not write, still gets
// the 403 the write lane raises (`assertMayWriteAtScope`).
//
// ── THE ONE DELIBERATE EXCEPTION ────────────────────────────────────────────
// `GET admin/settings/features/effective` serves the `Feature Availability`
// VALUES to every admin, tenant admins included, although those descriptors are
// `globalOnly`. That is not a hole: the console cannot decide whether to render
// a screen without knowing whether the feature exists for it, and the answer
// ("MCP is off for your tenant") is a fact about the caller's own tenant, not
// about the platform's configuration. Values only — never the descriptor
// inventory, never a write path. See the AUTH-NOTE on that route.

import { SettingDescriptor } from './registry.types';

/**
 * True when a TENANT administrator may see and address this key.
 *
 * Pure, so both the catalog listing and the three key-addressed routes decide
 * from one statement — a filter and a guard that can disagree are how the
 * previous gap survived.
 */
export function isTenantVisibleSetting(descriptor: SettingDescriptor): boolean {
  if (descriptor.globalOnly) return false;
  return descriptor.maxScope !== 'system';
}

/**
 * The catalog as `caller` may see it.
 *
 * @param elevated `isSuperAdmin(user)` — a platform admin sees everything,
 *   including the keys no screen can write, because the inventory IS the
 *   platform admin's map of the deployment.
 */
export function visibleSettings(descriptors: readonly SettingDescriptor[], elevated: boolean): SettingDescriptor[] {
  return elevated ? [...descriptors] : descriptors.filter(isTenantVisibleSetting);
}
