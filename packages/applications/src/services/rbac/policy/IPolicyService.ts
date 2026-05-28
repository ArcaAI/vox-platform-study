/**
 * TASK-307 W6.2 — `IPolicyService` is the controller-facing seam that
 * replaces `databaseService.client.policy.*` calls inside
 * `PoliciesController` (C-10 / F-1 / H-9 from the multi-tenancy API
 * design audit). The interface is intentionally structural — the
 * controller continues to own its NestJS DTOs (which carry class-validator
 * decorators); the service speaks plain TypeScript so it stays platform-
 * agnostic and unit-testable.
 */
import type { PolicyRule } from '../../../authorization/policy.engine';

/** Allowed values for the persisted `Policy.scope` column. */
export type PolicyScope = 'GLOBAL' | 'TENANT';

/** Pure result of `validateRules` — mirrors the previous controller helper. */
export interface PolicyValidationResult {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

export interface PolicyListQuery {
  page: number;
  pageSize: number;
  search?: string;
  scope?: PolicyScope;
}

export interface CreatePolicyRequest {
  name: string;
  description?: string;
  scope: PolicyScope;
  rules: PolicyRule[];
}

export interface UpdatePolicyRequest {
  name?: string;
  description?: string;
  scope?: PolicyScope;
  rules?: PolicyRule[];
  /** Currently only `ENABLED` / `DISABLED` are accepted in PATCH bodies. */
  resourceStatus?: string;
}

/**
 * Raw Prisma row shape returned to the controller. We avoid binding to
 * the generated `Policy` model so the service stays decoupled from the
 * `@arcaai/database` package (preserves DDD layering — controller maps
 * this to the HTTP response DTO).
 */
export interface PolicyRecord {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  rules: unknown;
  resourceStatus: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PolicyListResult {
  data: PolicyRecord[];
  total: number;
}

export interface IPolicyService {
  validateRules(rules: PolicyRule[]): PolicyValidationResult;
  findAll(query: PolicyListQuery): Promise<PolicyListResult>;
  findOne(id: string): Promise<PolicyRecord | null>;
  create(request: CreatePolicyRequest): Promise<PolicyRecord>;
  update(id: string, request: UpdatePolicyRequest): Promise<PolicyRecord>;
  patch(id: string, request: UpdatePolicyRequest): Promise<PolicyRecord>;
  softDelete(id: string): Promise<{ id: string; name: string }>;
}

export const IPolicyService = Symbol('IPolicyService');
