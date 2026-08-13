/**
 * Types for the changelog surfaces, matching the frozen contract
 * `docs/implementation/TASK-648-Service-Version-And-Release-Registry/contracts/service-release.api.yaml`
 * `/changelog/*` paths. Do not add fields the contract does not define.
 */

export type ChangelogSeverity = 'INFO' | 'IMPORTANT' | 'BREAKING';
export type ChangelogAudience = 'ALL' | 'GLOBAL_ADMIN' | 'TENANT_ADMIN';
export type ChangelogPublishStatus = 'DRAFT' | 'PUBLISHED';

/** ChangelogEntryResponse. `body` is markdown — MUST be rendered sanitised. */
export interface ChangelogEntry {
  id: string;
  platformVersion: string;
  title: string;
  summary: string;
  body: string;
  severity: ChangelogSeverity;
  audience: ChangelogAudience;
  publishStatus: ChangelogPublishStatus;
  publishedAt: string | null;
  acknowledged: boolean;
}

/** POST /admin/changelog body (global-admin authoring; created as DRAFT). */
export interface CreateChangelogEntryRequest {
  platformVersion: string;
  title: string;
  summary: string;
  body: string;
  severity: ChangelogSeverity;
  audience: ChangelogAudience;
}

/** PATCH /admin/changelog/:id body — OCC-guarded (If-Match required). */
export type UpdateChangelogEntryRequest = Partial<CreateChangelogEntryRequest>;
