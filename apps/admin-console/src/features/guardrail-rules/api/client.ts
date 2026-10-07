import { getJson, putWithEtag } from '@/shared/api';
import type { TenantGuardrailPolicy, UpdateTenantGuardrailPolicyRequest } from './types';

const BASE = 'admin/guardrail/policy';

export function getGuardrailPolicy(): Promise<TenantGuardrailPolicy> {
  return getJson(BASE);
}

/** The If-Match token is the row's own `version` (`"0"` creates the row). */
export async function putGuardrailPolicy(body: UpdateTenantGuardrailPolicyRequest, version: number): Promise<TenantGuardrailPolicy> {
  return (await putWithEtag<TenantGuardrailPolicy>(BASE, body, `"${version}"`)).data;
}
