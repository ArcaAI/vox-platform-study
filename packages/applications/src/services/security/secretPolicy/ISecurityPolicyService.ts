import { SecurityPolicyResponse, UpdateSecurityPolicyRequest } from './dto';

export const ISecurityPolicyService = Symbol('ISecurityPolicyService');

/**
 * The SUPER_ADMIN-facing credential-policy surface: read the platform's whole
 * credential posture in one call, and write it in one call.
 *
 * Both families it exposes are ordinary registry keys, so the generic
 * `GET/PUT /admin/settings/registry/:key` lane can already reach them one at a
 * time. This exists because a credential policy is only meaningful as a WHOLE:
 * an operator deciding "12 characters with four character classes, 32-byte
 * machine secrets" should see and set that as one object, not reconstruct it
 * from eight separate reads and then discover which of eight writes failed.
 */
export interface ISecurityPolicyService {
  /** Effective policy (stored rows over code defaults) plus the bounds a write must satisfy. */
  getPolicy(): SecurityPolicyResponse;
  /** Apply a PARTIAL update; only the fields present are written. */
  updatePolicy(dto: UpdateSecurityPolicyRequest): Promise<SecurityPolicyResponse>;
}
