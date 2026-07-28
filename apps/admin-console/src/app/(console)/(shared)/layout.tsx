import type { ReactNode } from 'react';

/**
 * Tier 20–29 (shared) group: reachable by any authenticated admin session —
 * the (console) layout already enforces authentication, and per-capability
 * visibility is the ability's job (per-screen guards + gateway enforcement).
 * Screens scope to the working tenant via the BFF proxy's X-Tenant-Id.
 */
export default function SharedTierLayout({ children }: { children: ReactNode }) {
  return children;
}
