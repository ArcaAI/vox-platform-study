/**
 * `vox-node-codegen` — the CLI wrapper around {@link generate}.
 *
 * ```
 * vox-node-codegen [--check] [--manifest <path>] [--openapi <path>] [--out <dir>]
 * ```
 *
 * All four defaults are derived from this package's own location, so the two
 * scripts that matter (`pnpm --filter @arcaai/vox-node gen:admin` and
 * `gen:admin:check`) take no arguments and cannot be pointed at the wrong tree
 * by accident.
 *
 * Exit codes: `0` clean, `1` drift or a failed cross-check. `--check` prints
 * every drifted path, because "something changed" without saying what is the
 * least useful CI failure there is.
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { generate } from './run';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const DEFAULTS = {
  manifest: resolve(REPO_ROOT, 'apps', 'api', 'route-manifest.json'),
  openapi: resolve(REPO_ROOT, 'apps', 'api', 'openapi.json'),
  out: resolve(REPO_ROOT, 'packages', 'vox-node', 'src', 'resources', 'admin'),
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean', default: false },
      manifest: { type: 'string' },
      openapi: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      'Usage: vox-node-codegen [--check] [--manifest <path>] [--openapi <path>] [--out <dir>]\n\n' +
        '  --check     compare instead of writing; exit 1 on any drift\n' +
        `  --manifest  route manifest (default ${DEFAULTS.manifest})\n` +
        `  --openapi   OpenAPI document (default ${DEFAULTS.openapi})\n` +
        `  --out       output directory (default ${DEFAULTS.out})\n`,
    );
    return 0;
  }

  const outDir = values.out ? resolve(values.out) : DEFAULTS.out;
  const result = await generate({
    manifestPath: values.manifest ? resolve(values.manifest) : DEFAULTS.manifest,
    openApiPath: values.openapi ? resolve(values.openapi) : DEFAULTS.openapi,
    outDir,
    check: values.check,
  });

  const summary = `${result.areas} areas, ${result.methods} routes, ${result.schemas} schemas`;

  if (!values.check) {
    process.stdout.write(`[vox-node-codegen] wrote ${result.files.length} files (${summary}) to ${outDir}\n`);
    return 0;
  }

  if (result.drifted.length === 0 && result.orphaned.length === 0) {
    process.stdout.write(`[vox-node-codegen] no drift (${summary})\n`);
    return 0;
  }

  process.stderr.write(
    `[vox-node-codegen] DRIFT — the committed admin surface does not match what the generator produces from ` +
      `apps/api/route-manifest.json + apps/api/openapi.json.\n` +
      result.drifted.map((path) => `  - out of date or hand-edited: ${path}\n`).join('') +
      result.orphaned.map((path) => `  - no longer generated (delete it): ${path}\n`).join('') +
      `Run \`pnpm --filter @arcaai/vox-node gen:admin\` and commit the result. If the ROUTES changed, re-emit the inputs first ` +
      `(\`pnpm api:route-manifest\` and \`pnpm api:openapi\`).\n`,
  );
  return 1;
}

/* istanbul ignore next -- CLI entry, exercised end-to-end by the package scripts rather than by a unit test. */
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`[vox-node-codegen] failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
