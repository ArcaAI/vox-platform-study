// TASK-884: replace with the shared PortableBundle once merged.
//
// The portable-bundle envelope is OWNED by lane F (TASK-884), which is authoring
// `packages/workflow-contract/src/portable-bundle.ts` in parallel. This file is a LOCAL ALIAS of
// that contract so this lane can be written and tested against it before it lands; when lane F
// merges, delete this file and import `PortableBundle` from `@arcaai/workflow-contract`.
//
// The envelope is deliberately the same for agents and workflows. An export is a self-describing
// document a human may keep for a year and hand to a different deployment, so it states what it
// is (`kind`), what shape it is in (`schemaVersion`), when it was taken, and where it came from —
// none of which can be recovered from the payload afterwards.

/** Which capability the bundle carries. Workflows here; lane F adds the agent kind. */
export const WORKFLOW_DEFINITION_BUNDLE_KIND = 'workflow-definition';

/** Bumped only when the PAYLOAD shape changes incompatibly. An import refuses anything else. */
export const WORKFLOW_DEFINITION_BUNDLE_SCHEMA_VERSION = 1;

/**
 * WHICH tier authored the exported row, not which tenant.
 *
 * A tenant id is not carried: it is meaningless in the importing deployment and it would leak
 * one customer's identity into an artifact another customer may hold. The tier IS meaningful —
 * "this came from the platform template library" is provenance an importer should be able to
 * read.
 */
export type PortableSourceTenantKind = 'system' | 'global' | 'tenant';

export interface PortableSource {
  tenantKind: PortableSourceTenantKind;
  slug: string;
  versionNumber: number;
}

export interface PortableBundle<TKind extends string, TPayload> {
  kind: TKind;
  schemaVersion: number;
  /** ISO-8601 instant the export was taken. */
  exportedAt: string;
  source: PortableSource;
  payload: TPayload;
}
