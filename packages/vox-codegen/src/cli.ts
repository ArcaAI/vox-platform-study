/**
 * `vox-codegen` — the `bin` entry.
 *
 * npx @arcaai/vox-codegen --tenant <id> [--watch] [--out <path>]
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
import { watchCodegen } from './watch';

const DEFAULT_BASE_URL = 'http://localhost:8868';
const DEFAULT_OUT_FILE = './consultation-context-schema.generated.ts';
const DEFAULT_INTERVAL_MS = 5000;

const HELP_TEXT = `vox-codegen — emit TypeScript types from a tenant's consultation context schema

Usage:
  vox-codegen --tenant <id> [options]

Options:
  --tenant <id>       Tenant id to generate types for (required)
  --token <jwt>        Bearer token for a GLOBAL_ADMIN user (or set HOPE_API_TOKEN)
  --base-url <url>     Gateway origin (default: ${DEFAULT_BASE_URL}, or HOPE_API_BASE_URL)
  --department <id>    Prefer this department's schema default, falling back to the tenant default
  --out <path>         Output file path (default: ${DEFAULT_OUT_FILE})
  --watch               Keep polling and regenerate whenever the schema changes
  --interval <ms>       Poll interval in watch mode (default: ${DEFAULT_INTERVAL_MS})
  -h, --help             Show this help

The generated file is a build-time convenience, never a replacement for the
SDK's runtime discovery (\`useConsultationSchema()\`). Commit it like any other
source file; regenerate it whenever the tenant's schema changes.
`;

interface ParsedArgs {
  tenant?: string;
  token?: string;
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
  const baseUrl = args['base-url'] ?? process.env.HOPE_API_BASE_URL ?? DEFAULT_BASE_URL;
  const outFile = args.out ?? DEFAULT_OUT_FILE;
  const departmentId = args.department;

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
