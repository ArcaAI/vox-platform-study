/**
 * build the developer-portal specs from the two committed gateway artifacts.
 *
 *   apps/api/openapi.json (request/response TYPES, from the DTOs)
 *        x joined on `METHOD /path`
 *   apps/api/route-manifest.json (the AUTHORIZATION oracle)
 *        |
 *        v
 *   apps/admin-console/src/server/api-docs/openapi.admin.json — every documented route
 *   apps/admin-console/src/server/api-docs/openapi.business.json — only what a tenant credential can reach
 *
 * ## Why join at all
 *
 * The single most support-expensive question a developer asks is "why does my
 * API key get a 403 on this route?". The gateway already knows: the manifest
 * carries `apiKeyForbidden` (446 routes), `apiKeyScopes`, `svcScopes`,
 * `requiredPermissions` and `requiresIfMatch` per route. None of it reaches
 * `openapi.json`, because Nest's Swagger explorer only sees DTOs and
 * `@Api*` decorators — it cannot see `@ForbidApiKey()` or `@Authorize()`.
 *
 * So the answer is derived here, mechanically, and attached as vendor
 * extensions the renderer can show. Nothing about credentials is re-typed by
 * hand, which is the point: a decorator change re-emits the manifest, the
 * manifest re-emits these specs, and the portal cannot drift from the guard.
 *
 * ## Why two files rather than one filtered at request time
 *
 * The business projection must not merely HIDE admin routes in the UI — it
 * must not contain them. It is served to tenant developers, so an admin route
 * present in the payload is an information leak whatever the client renders.
 * Membership is decided by the manifest, never by a hand-maintained list:
 * a route reaches the business projection only if a tenant-presentable
 * credential can actually call it.
 *
 * ## Determinism
 *
 * Output is deep key-sorted and derives nothing from the clock, the
 * environment, or git — the files are committed and drift-gated
 * (`api:portal:check`), so a re-run on an unchanged tree must be
 * byte-identical.
 *
 *   pnpm api:portal # write
 *   pnpm api:portal:check # fail on drift
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const OPENAPI_PATH = resolve(REPO_ROOT, 'apps/api/openapi.json');
const MANIFEST_PATH = resolve(REPO_ROOT, 'apps/api/route-manifest.json');
const OUT_DIR = resolve(REPO_ROOT, 'apps/admin-console/src/server/api-docs');
const ADMIN_OUT = resolve(OUT_DIR, 'openapi.admin.json');
const BUSINESS_OUT = resolve(OUT_DIR, 'openapi.business.json');

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface ManifestRoute {
  controller: string;
  handler: string;
  method: string;
  path: string;
  svcScopes: string[];
  forbidServiceAccount: boolean;
  apiKeyForbidden: boolean;
  apiKeyScopes: string[];
  /** `null` = no metadata at all; `[]` = a bare `@Authorize()`. Not the same thing. */
  requiredPermissions: [string, string][] | null;
  isPublic: boolean;
  permissionMode: 'AND' | 'OR' | null;
  requiresIfMatch: boolean;
  apiExcluded: boolean;
}

export interface RouteManifest {
  globalPrefix: string;
  routes: ManifestRoute[];
}

export type OpenApiOperation = Record<string, unknown> & { tags?: string[] };
export type OpenApiDocument = Record<string, unknown> & {
  paths: Record<string, Record<string, OpenApiOperation>>;
  tags?: { name: string; description?: string }[];
};

// ── Derived credential facts ────────────────────────────────────────────────

/** The credential classes that can reach a route, as the guard pipeline decides it. */
export type CredentialClass = 'public' | 'user-jwt' | 'api-key' | 'service-account';

export interface HopeRouteFacts {
  plane: 'admin' | 'business';
  credentials: CredentialClass[];
  apiKeyScopes: string[];
  serviceAccountScopes: string[];
  abilities: string[];
  permissionMode: 'AND' | 'OR' | null;
  requiresIfMatch: boolean;
}

/**
 * Which credential classes can reach this route.
 *
 * Mirrors `UnifiedAuthGuard`, and the two rules that trip people up are
 * encoded literally:
 *
 *  - `@ForbidApiKey()` is checked BEFORE scopes and abilities, so the 403 is
 *    unconditional — a broadly-scoped key does not help.
 *  - **No scope declaration = deny-by-default** for both machine classes. An
 *    absent `apiKeyScopes` is a 403 expectation, not "unknown", so a route
 *    with no declared scopes is NOT reachable by that class.
 */
export function credentialsFor(route: ManifestRoute): CredentialClass[] {
  if (route.isPublic) return ['public'];

  const classes: CredentialClass[] = ['user-jwt'];
  if (!route.apiKeyForbidden && route.apiKeyScopes.length > 0) classes.push('api-key');
  if (!route.forbidServiceAccount && route.svcScopes.length > 0) classes.push('service-account');
  return classes;
}

export function factsFor(route: ManifestRoute, globalPrefix: string): HopeRouteFacts {
  return {
    plane: route.path.startsWith(`/${globalPrefix}/admin/`) ? 'admin' : 'business',
    credentials: credentialsFor(route),
    apiKeyScopes: [...route.apiKeyScopes].sort(),
    serviceAccountScopes: [...route.svcScopes].sort(),
    abilities: (route.requiredPermissions ?? []).map(([action, subject]) => `${action}:${subject}`).sort(),
    permissionMode: route.permissionMode,
    requiresIfMatch: route.requiresIfMatch,
  };
}

/**
 * Does this route belong in the projection tenant developers receive?
 *
 * Reachability by a tenant-presentable credential is the ONLY criterion. An
 * admin-plane route is excluded even if some credential could reach it,
 * because the business projection is a document about the tenant-facing API.
 */
export function isBusinessVisible(facts: HopeRouteFacts): boolean {
  if (facts.plane === 'admin') return false;
  return facts.credentials.some((credential) => credential === 'api-key' || credential === 'public' || credential === 'user-jwt');
}

/** A short human sentence rendered above the operation, so the facts are readable without decoding extensions. */
export function credentialNote(facts: HopeRouteFacts): string {
  if (facts.credentials.includes('public')) {
    return '**Credentials** — public: no authentication required.';
  }

  const parts: string[] = [];
  parts.push(facts.credentials.includes('api-key') ? 'API key **accepted**' : 'API key **rejected (403)**');
  parts.push(
    facts.credentials.includes('service-account')
      ? `service-account token accepted (scopes: ${facts.serviceAccountScopes.map((s) => `\`${s}\``).join(', ')})`
      : 'service-account token rejected',
  );

  const lines = [`**Credentials** — user JWT accepted; ${parts.join('; ')}.`];

  if (facts.credentials.includes('api-key')) {
    lines.push(`**API key scopes** — ${facts.apiKeyScopes.map((s) => `\`${s}\``).join(', ')}.`);
  }
  if (facts.abilities.length > 0) {
    lines.push(`**Abilities** — ${facts.abilities.map((a) => `\`${a}\``).join(facts.permissionMode === 'OR' ? ' or ' : ' and ')}.`);
  }
  if (facts.requiresIfMatch) {
    lines.push('**Concurrency** — requires `If-Match`. Omitting it is a `428`; a stale value is a `412`.');
  }

  lines.push('Scopes bind the credential, abilities bind the user it acts for; they compose as AND.');
  return lines.join('\n\n');
}

// ── Build ───────────────────────────────────────────────────────────────────

function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeysDeep) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted as T;
  }
  return value;
}

export interface BuildResult {
  admin: OpenApiDocument;
  business: OpenApiDocument;
  /** Routes present in the spec but absent from the manifest — enriched with nothing. */
  unmatched: string[];
}

export function buildPortalSpecs(document: OpenApiDocument, manifest: RouteManifest): BuildResult {
  const routesByKey = new Map(manifest.routes.map((route) => [`${route.method.toUpperCase()} ${route.path}`, route]));

  const adminPaths: OpenApiDocument['paths'] = {};
  const businessPaths: OpenApiDocument['paths'] = {};
  const businessTags = new Set<string>();
  const unmatched: string[] = [];

  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      const route = routesByKey.get(`${method.toUpperCase()} ${path}`);

      if (!route) {
        // `openapi-coverage-check` fails the build on this; here we simply pass
        // the operation through un-enriched rather than invent facts for it.
        unmatched.push(`${method.toUpperCase()} ${path}`);
        (adminPaths[path] ??= {})[method] = operation;
        continue;
      }

      const facts = factsFor(route, manifest.globalPrefix);
      const description = [operation.description, credentialNote(facts)].filter((part) => typeof part === 'string' && part.trim()).join('\n\n');

      const enriched: OpenApiOperation = {
        ...operation,
        description,
        'x-hope-plane': facts.plane,
        'x-hope-credentials': facts.credentials,
        'x-hope-api-key-scopes': facts.apiKeyScopes,
        'x-hope-service-account-scopes': facts.serviceAccountScopes,
        'x-hope-abilities': facts.abilities,
        'x-hope-permission-mode': facts.permissionMode,
        'x-hope-requires-if-match': facts.requiresIfMatch,
      };

      (adminPaths[path] ??= {})[method] = enriched;

      if (isBusinessVisible(facts)) {
        (businessPaths[path] ??= {})[method] = enriched;
        for (const tag of operation.tags ?? []) businessTags.add(tag);
      }
    }
  }

  const admin: OpenApiDocument = { ...document, paths: adminPaths };
  const business: OpenApiDocument = {
    ...document,
    paths: businessPaths,
    // Drop tag groups with nothing left in them, or the sidebar shows dozens of
    // empty administration sections to an audience that cannot call any of them.
    tags: (document.tags ?? []).filter((tag) => businessTags.has(tag.name)),
  };

  return { admin: sortKeysDeep(admin), business: sortKeysDeep(business), unmatched };
}

function countOperations(document: OpenApiDocument): number {
  return Object.values(document.paths).reduce((total, methods) => total + Object.keys(methods).length, 0);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const { admin, business, unmatched } = buildPortalSpecs(readJson<OpenApiDocument>(OPENAPI_PATH), readJson<RouteManifest>(MANIFEST_PATH));

  const outputs: [string, OpenApiDocument][] = [
    [ADMIN_OUT, admin],
    [BUSINESS_OUT, business],
  ];

  if (unmatched.length > 0) {
    console.warn(`[gen-api-portal] ${unmatched.length} operation(s) had no manifest route and were passed through un-enriched.`);
    console.warn('  Run `pnpm api:openapi:check` — the two artifacts are from different builds.');
  }

  let drifted = false;
  for (const [path, document] of outputs) {
    const serialized = `${JSON.stringify(document, null, 2)}\n`;

    if (checkOnly) {
      let current = '';
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        current = '';
      }
      if (current !== serialized) {
        console.error(`[gen-api-portal] DRIFT — ${path.replace(`${REPO_ROOT}/`, '')} is stale or hand-edited.`);
        drifted = true;
      }
      continue;
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialized, 'utf8');
    console.log(`[gen-api-portal] wrote ${countOperations(document)} operations to ${path.replace(`${REPO_ROOT}/`, '')}`);
  }

  if (drifted) {
    console.error('\nRun `pnpm api:portal` and commit the result. If the ROUTES changed, re-emit the inputs first:');
    console.error('  pnpm api:build && pnpm api:route-manifest && pnpm api:openapi\n');
    process.exit(1);
  }

  if (checkOnly) {
    console.log(`[gen-api-portal] no drift (admin ${countOperations(admin)} ops, business ${countOperations(business)} ops)`);
  }
}

if (process.argv[1]?.endsWith('gen-api-portal.ts')) {
  try {
    main();
  } catch (error) {
    console.error(`[gen-api-portal] ${(error as Error).message}`);
    process.exit(1);
  }
}
