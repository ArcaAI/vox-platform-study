/**
 * TASK-1033 T2 — every route the catalog's `consoleRoute` can take must exist
 * in the console's nav inventory, so an "Edit in …" link can never dangle.
 */

import { describe, expect, it } from 'vitest';
import { NAV_ENTRIES } from '@/shared/navigation/nav-config';

/** The owner routes the gateway descriptors name (db-config / entitlement / redis-flag). */
const CONSOLE_ROUTES = ['/tenants/storage', '/entitlements', '/features'] as const;

describe('catalog consoleRoute ↔ nav-config parity', () => {
  it.each(CONSOLE_ROUTES)('%s is a registered nav route', (route) => {
    expect(NAV_ENTRIES.some((entry) => entry.route === route)).toBe(true);
  });
});
