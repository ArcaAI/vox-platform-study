/**
 * The PORTABLE BUNDLE — the on-the-wire envelope a tenant admin exports and imports
 * (TASK-884 for agents; the same envelope carries workflow definitions).
 *
 * ## Why an envelope rather than "the row as JSON"
 *
 * An export leaves the system and comes back, possibly into a DIFFERENT tenant, possibly
 * months later, possibly after the payload's own shape has moved on. Three things must
 * therefore travel WITH the payload and be checkable before a single field of it is read:
 *
 * | Field | Answers |
 * |---|---|
 * | `kind` | "is this even the right sort of thing?" — an agent bundle POSTed to the workflow importer is refused by shape, not by a confusing downstream error |
 * | `schemaVersion` | "can this importer read it?" — a newer bundle is REFUSED, never partially applied |
 * | `source` | "where did it come from?" — recorded on the created row, and the only thing that distinguishes a platform template from another tenant's export |
 *
 * ## What a bundle is NOT
 *
 * It is not a backup and it is not a transfer of identity. It carries VALUES, never
 * REFERENCES that are meaningful only inside the tenant that owns them — no credentials,
 * no `AiProviderConnection` id, no row ids, no tenant id. Where a payload must name a
 * platform object it names it BY SLUG, which the importer re-resolves against the importing
 * tenant's own visible catalogue and refuses when it cannot (the `AgentPromotion` discipline:
 * copy values, rewrite or refuse references, never write a dangling one).
 *
 * `source.tenantKind` is deliberately a KIND, not a tenant id: `'system'` (the platform
 * template tier), `'global'` (the platform-admin playground — a customer tenant, so its
 * exports are a customer's, never a tier) or `'tenant'` (anyone else). Exporting the literal
 * uuid would leak one customer's identity into another's file for no gain, and the importer
 * has no use for it — it re-resolves everything in its OWN tenant regardless.
 *
 * This module is PURE and dependency-free, like the rest of `@arcaai/workflow-contract`: it
 * declares the envelope and validates its STRUCTURE. What a valid `payload` is belongs to
 * whoever owns that `kind`.
 */

/** The bundle envelope version. Bumped only when the ENVELOPE changes, never for a payload change. */
export const PORTABLE_BUNDLE_SCHEMA_VERSION = 1;

/** What a bundle carries. One `kind` per exportable resource class. */
export const PORTABLE_BUNDLE_KINDS = Object.freeze(['agent', 'workflow'] as const);
export type PortableBundleKind = (typeof PORTABLE_BUNDLE_KINDS)[number];

/**
 * WHICH TIER a bundle came out of, without naming a tenant.
 * `system` = the platform template tier; `global` = the platform-admin playground (a customer
 * tenant); `tenant` = any other customer tenant.
 */
export const PORTABLE_BUNDLE_TENANT_KINDS = Object.freeze(['system', 'global', 'tenant'] as const);
export type PortableBundleTenantKind = (typeof PORTABLE_BUNDLE_TENANT_KINDS)[number];

export interface PortableBundleSource {
  /** The tier the bundle was exported from — never a tenant id. */
  readonly tenantKind: PortableBundleTenantKind;
  /** The exported resource's lineage key. */
  readonly slug: string;
  /** The exact version exported. */
  readonly version: number;
}

export interface PortableBundle<TPayload = unknown> {
  readonly kind: PortableBundleKind;
  readonly schemaVersion: number;
  /** ISO-8601 instant the bundle was produced. */
  readonly exportedAt: string;
  readonly source: PortableBundleSource;
  readonly payload: TPayload;
}

export interface PortableBundleProblem {
  readonly path: string;
  readonly message: string;
}

export interface PortableBundleExpectation {
  /** Refuse a bundle of any other kind. Omitted = accept any known kind. */
  readonly kind?: PortableBundleKind;
  /** The highest envelope version this importer understands. Defaults to the current one. */
  readonly maxSchemaVersion?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoInstant(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/**
 * Structural problems with a bundle ENVELOPE. Empty ⇒ the envelope is well-formed and the
 * caller may read `payload` as the shape its `kind` defines.
 *
 * Every problem is fatal by construction — there is no WARNING severity here, because a
 * malformed envelope is not a bundle a caller may partially honour. The importer maps these
 * to one 400 naming the first offending path.
 */
export function portableBundleProblems(value: unknown, expectation: PortableBundleExpectation = {}): PortableBundleProblem[] {
  if (!isPlainObject(value)) {
    return [{ path: '', message: 'A portable bundle must be a JSON object.' }];
  }
  const problems: PortableBundleProblem[] = [];
  const maxSchemaVersion = expectation.maxSchemaVersion ?? PORTABLE_BUNDLE_SCHEMA_VERSION;

  const kind = value.kind;
  if (typeof kind !== 'string' || !(PORTABLE_BUNDLE_KINDS as readonly string[]).includes(kind)) {
    problems.push({ path: 'kind', message: `\`kind\` must be one of ${PORTABLE_BUNDLE_KINDS.join(', ')}.` });
  } else if (expectation.kind !== undefined && kind !== expectation.kind) {
    problems.push({ path: 'kind', message: `This importer accepts \`${expectation.kind}\` bundles; this one is \`${kind}\`.` });
  }

  const schemaVersion = value.schemaVersion;
  if (!Number.isInteger(schemaVersion) || (schemaVersion as number) < 1) {
    problems.push({ path: 'schemaVersion', message: '`schemaVersion` must be a positive integer.' });
  } else if ((schemaVersion as number) > maxSchemaVersion) {
    // Refused, never best-effort: a newer envelope may carry fields whose ABSENCE from this
    // reader's model changes meaning, and half-importing a configuration is worse than not
    // importing it.
    problems.push({
      path: 'schemaVersion',
      message: `Bundle schema version ${schemaVersion} is newer than this platform understands (${maxSchemaVersion}); upgrade before importing it.`,
    });
  }

  if (!isIsoInstant(value.exportedAt)) {
    problems.push({ path: 'exportedAt', message: '`exportedAt` must be an ISO-8601 instant.' });
  }

  const source = value.source;
  if (!isPlainObject(source)) {
    problems.push({ path: 'source', message: '`source` must be an object naming the tenant kind, slug and version the bundle came from.' });
  } else {
    if (typeof source.tenantKind !== 'string' || !(PORTABLE_BUNDLE_TENANT_KINDS as readonly string[]).includes(source.tenantKind)) {
      problems.push({ path: 'source.tenantKind', message: `\`source.tenantKind\` must be one of ${PORTABLE_BUNDLE_TENANT_KINDS.join(', ')}.` });
    }
    if (typeof source.slug !== 'string' || source.slug.length === 0) {
      problems.push({ path: 'source.slug', message: '`source.slug` is required.' });
    }
    if (!Number.isInteger(source.version) || (source.version as number) < 1) {
      problems.push({ path: 'source.version', message: '`source.version` must be a positive integer.' });
    }
  }

  if (!isPlainObject(value.payload)) {
    problems.push({ path: 'payload', message: '`payload` must be a JSON object.' });
  }

  return problems;
}

/** A well-formed envelope of the expected kind. The `payload` is still `unknown` — its owner validates it. */
export function isPortableBundle(value: unknown, expectation: PortableBundleExpectation = {}): value is PortableBundle {
  return portableBundleProblems(value, expectation).length === 0;
}

/** Build an envelope around an already-validated payload. `exportedAt` is the caller's clock, passed in so exports are testable. */
export function buildPortableBundle<TPayload>(
  kind: PortableBundleKind,
  source: PortableBundleSource,
  payload: TPayload,
  exportedAt: Date = new Date(),
): PortableBundle<TPayload> {
  return {
    kind,
    schemaVersion: PORTABLE_BUNDLE_SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    source,
    payload,
  };
}
