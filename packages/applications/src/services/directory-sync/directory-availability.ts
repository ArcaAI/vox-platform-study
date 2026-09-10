import { BadRequestException } from '@nestjs/common';
import type { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import {
  TENANT_IDP_GOOGLE_DIRECTORY_ENABLED_KEY,
  TENANT_IDP_MS_GRAPH_ENABLED_KEY,
} from '../settings-registry/descriptors/feature-availability.descriptors';

/**
 * TASK-870 item 12 — is this directory API available to THIS tenant?
 *
 * Lives in one file because two callers need the same answer and the mapping from
 * a `config.directoryProvider` string to a settings key must exist exactly once:
 * `DirectorySyncService.enqueueSync` (the front door, which owes an HTTP caller a
 * 400 rather than a job that fails minutes later) and `DirectorySyncProcessor`
 * (where the work happens, so a capability a platform admin has just disabled does
 * not keep running because a job was already queued). Both hold a `tenantId`;
 * neither may answer for a tenant other than its own.
 *
 * It replaces a platform-wide env var frozen in each provider's CONSTRUCTOR. The
 * freeze needed a redeploy, but the SCOPE was the real defect — see the
 * descriptors for the full reasoning.
 *
 * ## FAIL CLOSED, unlike a tuning knob
 *
 * An unresolvable TUNING value degrades to its default (`failMode:
 * 'open-to-default'`); a capability must never grant itself. Here those two rules
 * agree rather than conflict, because the declared default IS `false` — so an
 * absent facade, an absent row and a resolution failure all deny, and none of them
 * has to be special-cased.
 */
const KEY_BY_DIRECTORY_PROVIDER: Record<string, string> = {
  'google-directory': TENANT_IDP_GOOGLE_DIRECTORY_ENABLED_KEY,
  'ms-graph': TENANT_IDP_MS_GRAPH_ENABLED_KEY,
};

/** The settings key gating one directory API, or undefined for an unknown provider. */
export function directoryAvailabilityKey(directoryProvider: string | undefined): string | undefined {
  return directoryProvider ? KEY_BY_DIRECTORY_PROVIDER[directoryProvider] : undefined;
}

/**
 * Resolve the gate for `tenantId`. `false` for an unknown provider, an unwired
 * facade, or a resolution failure — the caller decides how to refuse, since the
 * enqueue path owes a 400 and the worker owes a thrown job.
 */
export async function isDirectorySyncEnabled(
  effectiveSettings: EffectiveSettingsService | undefined,
  tenantId: string,
  directoryProvider: string | undefined,
): Promise<boolean> {
  const key = directoryAvailabilityKey(directoryProvider);
  if (!key || !effectiveSettings) return false;
  try {
    const resolved = await effectiveSettings.resolveEffective(key, { tenantId });
    return resolved.value === true || String(resolved.value) === 'true';
  } catch {
    // A control-plane blip denies a capability rather than granting one. The
    // caller's message names the setting, so this is diagnosable without a log
    // dive — and the refusal is identical to "not enabled", which is the honest
    // answer when we cannot establish that it is.
    return false;
  }
}

/** The refusal an admin-facing caller raises. Names the SETTING, never the env var. */
export function directorySyncDisabledError(directoryProvider: string | undefined): BadRequestException {
  const key = directoryAvailabilityKey(directoryProvider);
  return new BadRequestException(
    key
      ? `Directory sync is not enabled for this tenant (${key}). A platform administrator enables it per tenant.`
      : `Unsupported directoryProvider: ${String(directoryProvider)}`,
  );
}
