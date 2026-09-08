/**
 * `vox-codegen` — the `bin` entry.
 *
 * TWO modes, one per credential class, mutually exclusive by construction:
 *
 * ```
 * npx @arcaai/vox-codegen --tenant <id> --token <jwt> [--watch] [--out <path>]
 * npx @arcaai/vox-codegen --api-key <key> [--agents] [--workflows] [--out <dir>]
 * ```
 *
 * The first types a tenant's consultation CONTEXT SCHEMA from a super-admin JWT — a platform
 * operator's view. The second (TASK-931) types what the tenant PUBLISHES, from the API key an
 * integrator actually holds. Mixing them is a refusal rather than a guess: they authenticate
 * differently, read different routes, and answer different questions, so "which did you mean"
 * has no safe default.
 *
 * Zero CLI-parsing dependencies: `node:util`'s `parseArgs` (Node >= 18) is
 * enough for this flag set, and this package otherwise carries zero runtime
 * dependencies (matches `@arcaai/vox-node`'s posture — see the package
 * README's placement decision).
 */

import { parseArgs } from 'node:util';
import process from 'node:process';
import { CodegenError } from './errors';
import { runCodegenOnce } from './run';
import { runCatalogueCodegenOnce } from './run-catalogue';
import { watchCodegen } from './watch';

const DEFAULT_BASE_URL = 'http://localhost:8868';
const DEFAULT_OUT_FILE = './consultation-context-schema.generated.ts';
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_OUT_DIR = './generated';

const HELP_TEXT = `vox-codegen — emit TypeScript types from a tenant's HOPE configuration

Two modes, one per credential class. They are mutually exclusive.

CONSULTATION CONTEXT SCHEMA (super-admin JWT)
  vox-codegen --tenant <id> --token <jwt> [options]

  --tenant <id>        Tenant id to generate types for (required)
  --token <jwt>        Bearer token for a SUPER_ADMIN user (or set HOPE_API_TOKEN)
  --department <id>    Prefer this department's schema default, falling back to the tenant default
  --out <path>         Output FILE path (default: ${DEFAULT_OUT_FILE})
  --watch              Keep polling and regenerate whenever the schema changes
  --interval <ms>      Poll interval in watch mode (default: ${DEFAULT_INTERVAL_MS})

PUBLISHED AGENTS AND WORKFLOWS (API key — the business plane)
  vox-codegen --api-key <key> [--agents] [--workflows] [options]

  --api-key <key>      Tenant API key (or set HOPE_API_KEY). Never reaches an admin route.
  --agents             Emit Agent_<Slug>_Input / _Output for every published agent
  --workflows          Emit Workflow_<Slug>_Input / _Output for every published workflow
  --out <dir>          Output DIRECTORY (default: ${DEFAULT_OUT_DIR})

COMMON
  --base-url <url>     Gateway origin (default: ${DEFAULT_BASE_URL}, or HOPE_API_BASE_URL)
  -h, --help           Show this help

Generated files are a build-time convenience, never a replacement for runtime
discovery (\`useConsultationSchema()\`, \`hope.agents.list()\`). Commit them like any
other source file; regenerate whenever the tenant changes what it publishes.
`;

interface ParsedArgs {
  tenant?: string;
  token?: string;
  'api-key'?: string;
  agents: boolean;
  workflows: boolean;
  'base-url'?: string;
  department?: string;
  out?: string;
  watch: boolean;
  interval?: string;
  help: boolean;
}

function readArgs(argv: string[]): ParsedArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      tenant: { type: 'string' },
      token: { type: 'string' },
      'api-key': { type: 'string' },
      agents: { type: 'boolean', default: false },
      workflows: { type: 'boolean', default: false },
      'base-url': { type: 'string' },
      department: { type: 'string' },
      out: { type: 'string' },
      watch: { type: 'boolean', default: false },
      interval: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  return values as ParsedArgs;
}

/**
 * The business-plane mode: read the published catalogue with an API key, write one file per
 * requested plane. Returns the process exit code, like {@link main}, and never throws for an
 * operator error — those are messages on stderr, which is what an operator can act on.
 */
async function runBusinessPlane(options: {
  apiKey: string | undefined;
  baseUrl: string;
  agents: boolean;
  workflows: boolean;
  outDir: string;
  watch: boolean;
}): Promise<number> {
  if (!options.apiKey) {
    process.stderr.write('vox-codegen: --agents / --workflows need a tenant API key — pass --api-key or set HOPE_API_KEY\n');
    return 1;
  }
  if (!options.agents && !options.workflows) {
    process.stderr.write('vox-codegen: --api-key needs at least one of --agents / --workflows to know what to emit\n');
    return 1;
  }
  if (options.watch) {
    // Not an omission: the context-schema mode polls one endpoint and compares its `etag`.
    // A published catalogue is N definitions with no aggregate validator, so a watch here
    // would be an N-request poll that cannot tell "unchanged" from "not read yet".
    process.stderr.write(
      'vox-codegen: --watch is only supported for the consultation-context mode (--tenant); a published catalogue has no aggregate etag to poll\n',
    );
    return 1;
  }

  try {
    const result = await runCatalogueCodegenOnce({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      agents: options.agents,
      workflows: options.workflows,
      outDir: options.outDir,
    });
    for (const file of result.files) {
      process.stdout.write(`vox-codegen: wrote ${file.path} (${file.count} ${file.surface})\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof CodegenError) {
      process.stderr.write(`vox-codegen: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/** Runs one CLI invocation and returns the process exit code. Never calls `process.exit` itself — the caller decides when that happens. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ParsedArgs;
  try {
    args = readArgs(argv);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`vox-codegen: ${reason}\n`);
    return 1;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const tenantId = args.tenant;
  const token = args.token ?? process.env.HOPE_API_TOKEN;
  const apiKey = args['api-key'] ?? process.env.HOPE_API_KEY;
  const baseUrl = args['base-url'] ?? process.env.HOPE_API_BASE_URL ?? DEFAULT_BASE_URL;
  const departmentId = args.department;
  const wantsCatalogue = args.agents || args.workflows;

  // The two modes authenticate differently and read different routes. Refuse the combination
  // rather than pick one: a run that silently ignored half the flags would emit a file the
  // operator did not ask for, and they would find out at review time or not at all.
  if (apiKey !== undefined && tenantId !== undefined) {
    process.stderr.write(
      'vox-codegen: --api-key and --tenant are mutually exclusive. --tenant reads a consultation context schema ' +
        'with a SUPER_ADMIN JWT; --api-key reads the published agents and workflows on the business plane. Run one, then the other.\n',
    );
    return 1;
  }

  if (apiKey !== undefined || wantsCatalogue) {
    return runBusinessPlane({
      apiKey,
      baseUrl,
      agents: args.agents,
      workflows: args.workflows,
      outDir: args.out ?? DEFAULT_OUT_DIR,
      watch: args.watch,
    });
  }

  const outFile = args.out ?? DEFAULT_OUT_FILE;

  if (!tenantId) {
    process.stderr.write('vox-codegen: --tenant <id> is required\n');
    return 1;
  }
  if (!token) {
    process.stderr.write('vox-codegen: a bearer token is required — pass --token or set HOPE_API_TOKEN\n');
    return 1;
  }

  let intervalMs = DEFAULT_INTERVAL_MS;
  if (args.interval !== undefined) {
    intervalMs = Number(args.interval);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      process.stderr.write(`vox-codegen: --interval must be a positive number of milliseconds, got ${args.interval}\n`);
      return 1;
    }
  }

  const common = { tenantId, token, baseUrl, departmentId, outFile };

  try {
    if (args.watch) {
      process.stdout.write(`vox-codegen: watching tenant ${tenantId} every ${intervalMs}ms → ${outFile} (Ctrl+C to stop)\n`);
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      process.once('SIGTERM', () => controller.abort());
      await watchCodegen({
        ...common,
        intervalMs,
        signal: controller.signal,
        onCycle: ({ changed, etag }) => {
          if (changed) process.stdout.write(`vox-codegen: regenerated ${outFile} (etag ${etag})\n`);
        },
      });
    } else {
      const result = await runCodegenOnce(common);
      process.stdout.write(`vox-codegen: wrote ${outFile} (etag ${result.bundle.etag})\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof CodegenError) {
      process.stderr.write(`vox-codegen: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/* c8 ignore start -- exercised via process spawn / manual runs, not unit tests */
if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console -- last-resort crash reporter, not the normal CLI output path
      console.error(error);
      process.exitCode = 1;
    });
}
/* c8 ignore stop */
