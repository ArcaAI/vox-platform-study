/**
 * TASK-783 — cross-check `apps/api/openapi.json` against `apps/api/route-manifest.json`.
 *
 * Both files are committed build artifacts of the same Nest application, so
 * they must describe the same set of routes. When they don't, one of three
 * things is true, and this script exists to tell them apart:
 *
 * | Symptom | Meaning |
 * |---|---|
 * | in the manifest, absent from the spec, NOT `apiExcluded` | **a documentation defect** — the route ships with no Swagger metadata, so it is invisible in the developer reference |
 * | in the manifest, absent from the spec, `apiExcluded: true` | fine — `@ApiExcludeController()` / `@ApiExcludeEndpoint()` says so on purpose |
 * | in the spec, absent from the manifest | **a stale artifact** — one of the two was regenerated and the other was not |
 *
 * That third case is not hypothetical: `openapi.json` was one commit behind
 * `route-manifest.json` when this script was written (TASK-733 added
 * `DELETE /admin/dna-writing-styles/doctor/{doctorId}` and only the manifest
 * was re-emitted), and nothing caught it.
 *
 * Neither is the first case's inverse. Until TASK-783 the manifest's
 * `apiExcluded` flag was ALWAYS false — it read `@nestjs/swagger`'s wrapped
 * metadata with `=== true` — so all 70 deliberately-excluded routes looked
 * like documentation defects and 70 real ones would have looked normal. The
 * flag is the whole basis of the distinction above, which is why
 * `src/openapi/__tests__/api-exclude-metadata.test.ts` locks it against the
 * real decorators.
 *
 * Runs offline against two JSON files: no Nest boot, no database, no network.
 *
 *   pnpm api:openapi:check
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const OPENAPI_PATH = resolve(REPO_ROOT, 'apps/api/openapi.json');
const MANIFEST_PATH = resolve(REPO_ROOT, 'apps/api/route-manifest.json');

/**
 * Documentation-quality RATCHET.
 *
 * Measured 2026-08-20 (TASK-783). These are not targets — they are the WORST the
 * repo is allowed to get. A change that leaves more operations undocumented than
 * this fails; a change that improves matters is expected to lower the numbers in
 * the same commit.
 *
 * Failing on the absolute counts today would block every unrelated change, and a
 * gate that has to be bypassed is not a gate. A ratchet is the version of this
 * that can actually be turned on, and it makes the debt visible in the diff
 * rather than in a report nobody reads.
 *
 * Lowering a number needs no justification. RAISING one does, in the commit
 * message: it means a route shipped without documentation on purpose.
 */
export interface QualityRatchet {
  withoutSummary: number;
  withoutDescription: number;
  withoutFailureMode: number;
}

export const QUALITY_RATCHET: QualityRatchet = {
  withoutSummary: 1,
  withoutDescription: 412,
  withoutFailureMode: 290,
};

/**
 * Domains reserved for documentation (RFC 2606 / RFC 6761). An e-mail example
 * outside these is either a real address — which does not belong in a published
 * document — or a placeholder someone will eventually send mail to.
 */
const RESERVED_EXAMPLE_DOMAINS = /(^|\.)(example\.(com|org|net)|test|invalid|localhost)$/;

/**
 * Seeded identities that must never appear in a published example.
 *
 * The SYSTEM tenant (`00000000-…`) and the GLOBAL customer tenant (`50000000-…`)
 * ARE deliberately shown — they are documented platform constants a caller has to
 * recognise (see `.claude/rules/00-project-context.md`). The system user and the
 * seeded API keys are not: an example that hands a reader a credential id teaches
 * them to send it.
 */
const FORBIDDEN_SEED_IDS: [label: string, pattern: RegExp][] = [
  ['seeded system user (60000000-…)', /60000000-0000-0000-0000-[0-9a-f]{12}/g],
  ['seeded API key / user id (70000000-…)', /70000000-0000-0000-0000-[0-9a-f]{12}/g],
];

export interface ManifestRoute {
  controller: string;
  handler: string;
  method: string;
  path: string;
  apiExcluded: boolean;
}

export interface RouteManifest {
  routes: ManifestRoute[];
}

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  responses?: Record<string, unknown>;
}

export interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  tags?: { name: string }[];
}

/** `GET /api/v1/thing` — the join key between the two artifacts. */
function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new Error(`could not read ${path}: ${(error as Error).message}. Run \`pnpm api:openapi\` and \`pnpm api:route-manifest\` first.`);
  }
}

export interface CoverageReport {
  manifestRoutes: number;
  specOperations: number;
  excluded: number;
  withoutSummary: number;
  withoutDescription: number;
  withoutFailureMode: number;
  withoutTag: number;
  /** Example-hygiene violations, if any. */
  hygiene: string[];
  /** Human-readable blocks; empty means the gate passes. */
  failures: string[];
}

/**
 * Examples are published verbatim to whoever can read the portal, so they are
 * checked for the two things that are never appropriate in one: a real e-mail
 * address, and a seeded credential identity.
 */
export function checkExampleHygiene(document: OpenApiDocument): string[] {
  const serialized = JSON.stringify(document);
  const violations: string[] = [];

  for (const address of new Set(serialized.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [])) {
    const domain = address.slice(address.indexOf('@') + 1).toLowerCase();
    if (!RESERVED_EXAMPLE_DOMAINS.test(domain)) {
      violations.push(`e-mail example on a non-reserved domain: ${address} (use example.com — RFC 2606)`);
    }
  }

  for (const [label, pattern] of FORBIDDEN_SEED_IDS) {
    for (const id of new Set(serialized.match(pattern) ?? [])) {
      violations.push(`${label} appears in the document: ${id}`);
    }
  }

  return violations.sort();
}

/**
 * The gate itself, as a pure function over the two parsed artifacts, so
 * `__tests__/check-openapi-coverage.test.ts` can prove it goes RED on each
 * failure mode without touching the committed files.
 */
export function checkOpenApiCoverage(
  document: OpenApiDocument,
  manifest: RouteManifest,
  // Injectable so the REGRESSION path is testable on a small fixture. A gate
  // whose failure branch has never been exercised is a gate you are guessing about.
  ratchet: QualityRatchet = QUALITY_RATCHET,
): CoverageReport {
  const specOperations = new Map<string, OpenApiOperation>();
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      specOperations.set(routeKey(method, path), operation);
    }
  }

  const manifestKeys = new Set(manifest.routes.map((route) => routeKey(route.method, route.path)));

  // ── 1. Documentation defects: a live route with no Swagger metadata ──
  const undocumented = manifest.routes
    .filter((route) => !route.apiExcluded && !specOperations.has(routeKey(route.method, route.path)))
    .map((route) => `  ${routeKey(route.method, route.path)}  (${route.controller}.${route.handler})`);

  // ── 2. Stale artifacts: the spec knows a route the manifest does not ──
  const orphaned = [...specOperations.keys()].filter((key) => !manifestKeys.has(key)).map((key) => `  ${key}`);

  // ── 3. Quality: reported, not enforced (see the ratchet note below) ──
  const documented = [...specOperations.values()];
  const withoutSummary = documented.filter((operation) => !operation.summary?.trim()).length;
  const withoutDescription = documented.filter((operation) => !operation.description?.trim()).length;
  const withoutFailureMode = documented.filter(
    (operation) => !Object.keys(operation.responses ?? {}).some((code) => code.startsWith('4')),
  ).length;
  const withoutTag = documented.filter((operation) => !operation.tags?.length).length;

  const excluded = manifest.routes.filter((route) => route.apiExcluded).length;

  const hygiene = checkExampleHygiene(document);
  const failures: string[] = [];

  if (hygiene.length > 0) {
    failures.push(
      [`${hygiene.length} example-hygiene violation(s) — these are published verbatim to portal readers:`, ...hygiene.map((v) => `  ${v}`)].join(
        '\n',
      ),
    );
  }

  const regressions = (
    [
      ['operations with no summary', withoutSummary, ratchet.withoutSummary],
      ['operations with no description', withoutDescription, ratchet.withoutDescription],
      ['operations with no 4xx response', withoutFailureMode, ratchet.withoutFailureMode],
    ] as const
  ).filter(([, actual, allowed]) => actual > allowed);

  if (regressions.length > 0) {
    failures.push(
      [
        'documentation quality went BACKWARDS:',
        ...regressions.map(([label, actual, allowed]) => `  ${label}: ${actual} (ratchet allows ${allowed})`),
        '',
        'A route shipped without documentation. Either document it (@ApiOperation summary +',
        'description, @ApiResponse for the failure modes) or, if that is genuinely intended,',
        'raise QUALITY_RATCHET in scripts/check-openapi-coverage.ts and say why in the commit.',
      ].join('\n'),
    );
  }

  if (undocumented.length > 0) {
    failures.push(
      [
        `${undocumented.length} route(s) are served but carry no OpenAPI metadata:`,
        ...undocumented,
        '',
        'Each one is invisible in the developer reference. Either document it',
        '(@ApiOperation + @ApiResponse) or mark it @ApiExcludeEndpoint() with a',
        'comment saying why.',
      ].join('\n'),
    );
  }

  if (orphaned.length > 0) {
    failures.push(
      [
        `${orphaned.length} operation(s) are in openapi.json but not in route-manifest.json:`,
        ...orphaned,
        '',
        'The two artifacts were emitted from different builds. Re-run both:',
        '  pnpm api:build && pnpm api:route-manifest && pnpm api:openapi',
      ].join('\n'),
    );
  }

  return {
    manifestRoutes: manifest.routes.length,
    specOperations: documented.length,
    excluded,
    withoutSummary,
    withoutDescription,
    withoutFailureMode,
    withoutTag,
    hygiene,
    failures,
  };
}

function main(): void {
  const report = checkOpenApiCoverage(readJson<OpenApiDocument>(OPENAPI_PATH), readJson<RouteManifest>(MANIFEST_PATH));

  console.log('[openapi-coverage]');
  console.log(`  manifest routes       ${report.manifestRoutes}`);
  console.log(`  spec operations       ${report.specOperations}`);
  console.log(`  deliberately excluded ${report.excluded}`);
  console.log('  quality (ratcheted — may improve, may not regress):');
  console.log(`    missing summary      ${report.withoutSummary} (max ${QUALITY_RATCHET.withoutSummary})`);
  console.log(`    missing description  ${report.withoutDescription} / ${report.specOperations} (max ${QUALITY_RATCHET.withoutDescription})`);
  console.log(`    missing 4xx response ${report.withoutFailureMode} / ${report.specOperations} (max ${QUALITY_RATCHET.withoutFailureMode})`);
  console.log(`    missing tag          ${report.withoutTag}`);
  console.log(`  example hygiene        ${report.hygiene.length === 0 ? 'clean' : `${report.hygiene.length} violation(s)`}`);

  if (report.failures.length > 0) {
    console.error(`\n[openapi-coverage] FAILED\n\n${report.failures.join('\n\n')}\n`);
    process.exit(1);
  }

  console.log('\n[openapi-coverage] OK — every served route is either documented or deliberately excluded.');
}

// Only run the CLI when invoked directly, so the test can import the checker.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  try {
    main();
  } catch (error) {
    console.error(`[openapi-coverage] ${(error as Error).message}`);
    process.exit(1);
  }
}
