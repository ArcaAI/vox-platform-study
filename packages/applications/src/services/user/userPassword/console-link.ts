import { Logger } from '@nestjs/common';
import type { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { CONSOLE_PUBLIC_BASE_URL_KEY } from '../../settings-registry/descriptors/console-public-url.descriptors';

const logger = new Logger('ConsoleLink');

/**
 * TASK-1056 — `console.publicBaseUrl` (tenant → SYSTEM) + `path`, or `null` when no tier sets it.
 * Fail-closed: an unset origin is never guessed, and never taken from the request `Host`.
 * `tenantId: null` resolves the platform tier (public routes with no tenant context).
 */
export function absolutizeConsoleLink(
  tenantSettings: Pick<TenantSettingsService, 'resolve'> | undefined,
  path: string,
  tenantId: string | null,
): string | null {
  if (!tenantSettings) return null;
  try {
    const { value } = tenantSettings.resolve<string>(CONSOLE_PUBLIC_BASE_URL_KEY, tenantId);
    const baseUrl = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
    return baseUrl ? `${baseUrl}${path}` : null;
  } catch (error) {
    logger.warn(`'${CONSOLE_PUBLIC_BASE_URL_KEY}' unresolved — no absolute console link: ${(error as Error).message}`);
    return null;
  }
}
