/** Platform credential policy (password complexity/rotation + issued-secret entropy). */

import { getJson, putJson } from '@/shared/api';
import type { SecurityPolicy, UpdateSecurityPolicyRequest } from './types';

const BASE = 'admin/security/policy';

export function getSecurityPolicy(): Promise<SecurityPolicy> {
  return getJson(BASE);
}

/** Partial write; the gateway returns the re-read EFFECTIVE policy. */
export function updateSecurityPolicy(body: UpdateSecurityPolicyRequest): Promise<SecurityPolicy> {
  return putJson(BASE, body);
}
