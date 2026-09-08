/**
 * Feature-gate client. Paths are gateway-relative; the shared core prepends
 * the `/api/hope` BFF proxy mount (see `features/settings-registry/api/client.ts`
 * for the sibling descriptor-registry lane this rides alongside).
 */

import { getJson } from '@/shared/api';
import type { FeatureGateMap } from './keys';

const BASE = 'admin/settings/features';

interface EffectiveFeatureGateItem {
  key: string;
  value: boolean;
  sourceScope: 'system' | 'tenant' | 'default';
}

interface EffectiveFeatureGatesResponse {
  items: EffectiveFeatureGateItem[];
}

/**
 * `GET admin/settings/features/effective` (Lane S) — every `Feature
 * Availability` key resolved for the caller (tenant -> SYSTEM cascade),
 * folded into a `{ key: value }` map. `sourceScope` is not surfaced here: the
 * console gate only needs the boolean, not where it came from.
 */
export async function getEffectiveFeatureGates(): Promise<FeatureGateMap> {
  const response = await getJson<EffectiveFeatureGatesResponse>(`${BASE}/effective`);
  const gates: Record<string, boolean> = {};
  for (const item of response.items) {
    gates[item.key] = item.value;
  }
  return gates;
}
