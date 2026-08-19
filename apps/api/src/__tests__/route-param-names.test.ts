/**
 * Route parameter names must be `[A-Za-z0-9_]+`.
 *
 * A hyphen does not fail loudly — it TERMINATES the parameter name.
 * path-to-regexp reads `:code-name` as a parameter called `code` followed by
 * the literal text `-name`, so the route:
 *
 *   - does not match the URL it appears to advertise (the literal suffix is
 *     required), and
 *   - binds nothing under the hyphenated name, so a matching `@Param('code-name')`
 *     resolves to `undefined` and the handler runs with a missing argument.
 *
 * Both failures are silent: no startup error, no type error, and the route
 * still "exists". `TenantController.fetchByCodeName` shipped this way and was
 * only caught because the TASK-773 SDK codegen cross-checks the Nest route
 * manifest against the OpenAPI document and refused to generate on the
 * disagreement — Swagger had been rendering the truth, `/code-name/{code}-name`,
 * the whole time.
 *
 * This test is the cheap version of that discovery: it reads the route paths
 * straight off the controller sources, so the mistake is caught at authoring
 * time by the suite that already runs on every merge request, without needing
 * a gateway boot or a codegen run.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const MODULES_ROOT = resolve(__dirname, '..', 'modules');
const API_ROOT = resolve(__dirname, '..', '..');

/** Every `*.controller.ts` under `src/modules`, recursively. */
function controllerFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...controllerFiles(full));
    else if (entry.endsWith('.controller.ts')) found.push(full);
  }
  return found;
}

/**
 * Route-path string literals: the argument of a routing decorator, or the
 * `path:` property of an `@ApiEndpoint({...})`. Deliberately narrow — matching
 * every string literal would sweep in scope strings like
 * `'svc:admin:tenant-tts-config:manage'`, whose hyphens are legitimate.
 */
const ROUTE_PATH_PATTERNS: readonly RegExp[] = [
  /@(?:Get|Post|Put|Patch|Delete|All|Head|Options|Controller)\(\s*'([^']*)'/g,
  /\bpath:\s*'([^']*)'/g,
];

/** A parameter segment whose name is cut short by a character path-to-regexp does not accept. */
const MALFORMED_PARAM = /:[A-Za-z0-9_]*[^A-Za-z0-9_/?*+()]/;

describe('route parameter names', () => {
  const files = controllerFiles(MODULES_ROOT);

  it('finds controllers to check (a broken glob would make this suite vacuous)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('never contain a character that silently truncates the parameter name', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      for (const pattern of ROUTE_PATH_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
          const routePath = match[1];
          if (!routePath.includes(':')) continue;
          if (!MALFORMED_PARAM.test(routePath)) continue;
          offenders.push(
            `${relative(API_ROOT, file)}: '${routePath}' — a parameter name here is terminated early. ` +
              `path-to-regexp accepts [A-Za-z0-9_]+, so everything from the first other character is a LITERAL, ` +
              `and @Param() under the full hyphenated name resolves to undefined. Use camelCase.`,
          );
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
