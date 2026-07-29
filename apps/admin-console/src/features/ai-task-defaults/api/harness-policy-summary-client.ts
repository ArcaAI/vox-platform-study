/**
 * Read-only GET of `admin/harness/policy` for the `/ai-configuration`
 * effective-policy summary card. No PATCH here — `harness-policy` owns the
 * write (see `harness-policy-summary-types.ts`).
 */

import { getJson } from '@/shared/api';
import type { HarnessPolicySummary } from './harness-policy-summary-types';

export function getHarnessPolicySummary(): Promise<HarnessPolicySummary> {
  return getJson('admin/harness/policy');
}
